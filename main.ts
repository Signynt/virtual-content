import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	MarkdownView,
	MarkdownRenderer,
	AbstractInputSuggest,
	Component,
	TFile,
	getAllTags,
} from 'obsidian';

// --- Enums ---

/** Defines the type of a rule (folder-based or tag-based). */
enum RuleType {
	Folder = 'folder',
	Tag = 'tag',
}

/** Defines the source of the content for a rule (direct text or a markdown file). */
enum ContentSource {
	Text = 'text',
	File = 'file',
}

/** Defines where the dynamic content should be rendered in the view. */
enum RenderLocation {
	Footer = 'footer',
	Header = 'header',
}

// --- Interfaces ---

/**
 * Represents a rule for injecting content.
 * Each rule can be type 'folder' or 'tag'.
 * Content can come from direct 'text' or a 'file'.
 * Content can be rendered in the 'footer' or 'header'.
 */
interface Rule {
	type: RuleType;
	path?: string; // For folder type: path to the folder, or "" for all files, or "/" for root
	tag?: string; // For tag type: the tag name (without '#')
	contentSource: ContentSource;
	footerText: string; // Direct text content if contentSource is 'text'
	footerFilePath?: string; // Path to .md file if contentSource is 'file'
	renderLocation: RenderLocation; // Where to render the content for this rule
}

/**
 * Defines the settings structure for the VirtualFooter plugin.
 */
interface VirtualFooterSettings {
	rules: Rule[];
}

/**
 * Extends HTMLElement to associate an Obsidian Component for lifecycle management.
 * This is used for dynamically injected content that needs its own component (e.g., for Markdown rendering).
 */
interface HTMLElementWithComponent extends HTMLElement {
	component?: Component;
}

// --- Constants ---

const DEFAULT_SETTINGS: VirtualFooterSettings = {
	rules: [{ type: RuleType.Folder, path: '', contentSource: ContentSource.Text, footerText: '', renderLocation: RenderLocation.Footer }],
};

// CSS Classes
const CSS_DYNAMIC_CONTENT_ELEMENT = 'virtual-footer-dynamic-content-element';
const CSS_HEADER_RENDERED_CONTENT = 'virtual-footer-header-rendered-content';
const CSS_FOOTER_RENDERED_CONTENT = 'virtual-footer-footer-rendered-content';
const CSS_VIRTUAL_FOOTER_CM_PADDING = 'virtual-footer-cm-padding'; // For Live Preview footer spacing
const CSS_VIRTUAL_FOOTER_REMOVE_FLEX = 'virtual-footer-remove-flex'; // For Live Preview footer styling

// DOM Selectors
const SELECTOR_EDITOR_CONTENT_AREA = '.cm-editor .cm-content'; // Live Preview content area
const SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT = '.markdown-source-view.mod-cm6 .cm-contentContainer'; // Parent for Live Preview styling
const SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER = '.cm-contentContainer'; // Target for Live Preview header injection
const SELECTOR_EDITOR_SIZER = '.cm-sizer'; // Target for Live Preview footer injection
const SELECTOR_PREVIEW_HEADER_AREA = '.mod-header.mod-ui'; // Reading mode header area
const SELECTOR_PREVIEW_FOOTER_AREA = '.mod-footer'; // Reading mode footer area

// Selectors for finding parent elements of potentially injected dynamic content (used for cleanup)
const SELECTORS_POTENTIAL_DYNAMIC_CONTENT_PARENTS = [
	SELECTOR_EDITOR_SIZER,
	SELECTOR_PREVIEW_FOOTER_AREA,
	SELECTOR_PREVIEW_HEADER_AREA,
	'.metadata-container .metadata-content', // Legacy selector for cleanup
	'.view-header',                          // Legacy selector for cleanup
];

// --- Utility Classes ---

/**
 * A suggestion provider for input fields, offering autocompletion from a given set of strings.
 */
export class MultiSuggest extends AbstractInputSuggest<string> {
	constructor(
		private inputEl: HTMLInputElement,
		private content: Set<string>,
		private onSelectCb: (value: string) => void,
		app: App
	) {
		super(app, inputEl);
	}

	getSuggestions(inputStr: string): string[] {
		const lowerCaseInputStr = inputStr.toLocaleLowerCase();
		return [...this.content].filter((contentItem) =>
			contentItem.toLocaleLowerCase().includes(lowerCaseInputStr)
		);
	}

	renderSuggestion(content: string, el: HTMLElement): void {
		el.setText(content);
	}

	selectSuggestion(content: string, _evt: MouseEvent | KeyboardEvent): void {
		this.onSelectCb(content);
		this.inputEl.value = content; // Update input field with selected suggestion
		this.inputEl.blur(); // Remove focus from input
		this.close(); // Close the suggestion popover
	}
}

// --- Main Plugin Class ---

/**
 * Main plugin class for VirtualFooter.
 * This plugin allows users to define custom footer (or header) content
 * that is dynamically injected into Markdown views based on folder-specific or tag-specific rules.
 */
export default class VirtualFooterPlugin extends Plugin {
	settings: VirtualFooterSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new VirtualFooterSettingTab(this.app, this));

		// Refresh content on file open or layout change
		this.registerEvent(
			this.app.workspace.on('file-open', this.handleActiveViewChange)
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', this.handleActiveViewChange)
		);

		// Initial processing for the currently active view
		this.handleActiveViewChange();
	}

	async onunload() {
		this.clearAllViewsDynamicContent();

		// Remove any globally applied styles or elements not tied to a specific view's component
		document.querySelectorAll(`.${CSS_DYNAMIC_CONTENT_ELEMENT}`).forEach(el => {
			const componentHolder = el as HTMLElementWithComponent;
			if (componentHolder.component) {
				componentHolder.component.unload();
			}
			el.remove();
		});

		document.querySelectorAll(`.${CSS_VIRTUAL_FOOTER_CM_PADDING}`).forEach(el => el.classList.remove(CSS_VIRTUAL_FOOTER_CM_PADDING));
		document.querySelectorAll(`.${CSS_VIRTUAL_FOOTER_REMOVE_FLEX}`).forEach(el => el.classList.remove(CSS_VIRTUAL_FOOTER_REMOVE_FLEX));
	}

	/**
	 * Handles changes in the active view, re-processing it for dynamic content.
	 * Bound `this` in `onload` to ensure correct context.
	 */
	private handleActiveViewChange = () => {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		this._processView(activeView);
	}

	/**
	 * Processes a given Markdown view to apply or remove dynamic content.
	 * @param view The MarkdownView to process, or null if no Markdown view is active.
	 */
	private async _processView(view: MarkdownView | null): Promise<void> {
		if (!view || !view.file) {
			this.clearAllViewsDynamicContent();
			return;
		}

		await this.removeDynamicContentFromView(view); // Clear existing content first

		const applicableRulesWithContent = await this._getApplicableRulesAndContent(view.file.path);

		if (applicableRulesWithContent.length === 0) {
			return; // No rules apply, cleanup already done.
		}

		const state = view.getState();
		let livePreviewFooterStylesApplied = false;

		for (const { rule, contentText } of applicableRulesWithContent) {
			// renderAndInjectContent will bail if contentText is empty.
			const isRenderInHeader = rule.renderLocation === RenderLocation.Header;

			// Apply specific styles ONLY IF this rule will render in the footer in Live Preview.
			// Apply only once per view processing pass.
			if (state.mode === 'source' && !state.source && !isRenderInHeader && !livePreviewFooterStylesApplied) { // Live Preview mode, footer rendering
				this.applyLivePreviewFooterStyles(view);
				livePreviewFooterStylesApplied = true;
			}

			// Render and inject content if in Preview mode or Live Preview mode.
			if (state.mode === 'preview' || (state.mode === 'source' && !state.source)) {
				await this.renderAndInjectContent(view, contentText, rule.renderLocation);
			}
		}
	}

	/**
	 * Renders the dynamic content based on rules and injects it into the specified view.
	 * @param view The MarkdownView to inject content into.
	 * @param contentText The text to render.
	 * @param renderLocation Where to render the content.
	 */
	private async renderAndInjectContent(view: MarkdownView, contentText: string, renderLocation: RenderLocation): Promise<void> {
		if (!contentText) {
			// Do not remove all injected content here, as this function is now called per rule.
			// If a specific rule has no content, it simply won't inject anything.
			// Global cleanup is handled by removeDynamicContentFromView before processing rules.
			return;
		}

		const isRenderInHeader = renderLocation === RenderLocation.Header;
		const sourcePath = view.file?.path || '';
		const { element: contentDiv, component } = await this.prepareContentElement(contentText, isRenderInHeader, sourcePath);

		let injectionSuccessful = false;
		const state = view.getState();

		if (state.mode === 'preview') { // Reading mode
			const targetParent = view.containerEl.querySelector<HTMLElement>(
				isRenderInHeader ? SELECTOR_PREVIEW_HEADER_AREA : SELECTOR_PREVIEW_FOOTER_AREA
			);
			if (targetParent) {
				targetParent.appendChild(contentDiv);
				injectionSuccessful = true;
			}
		} else if (state.mode === 'source' && !state.source) { // Live Preview editor mode
			if (isRenderInHeader) {
				const cmContentContainer = view.containerEl.querySelector<HTMLElement>(SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER);
				if (cmContentContainer?.parentElement) {
					cmContentContainer.parentElement.insertBefore(contentDiv, cmContentContainer);
					injectionSuccessful = true;
				}
			} else { // Live Preview footer
				const targetParent = view.containerEl.querySelector<HTMLElement>(SELECTOR_EDITOR_SIZER);
				if (targetParent) {
					targetParent.appendChild(contentDiv);
					injectionSuccessful = true;
				}
			}
		}

		if (injectionSuccessful) {
			this.attachInternalLinkHandlers(contentDiv, sourcePath, component);
		} else {
			component.unload();
			console.warn("VirtualFooter: Failed to find injection point for dynamic content for a rule.");
		}
	}

	/**
	 * Creates the HTML element for the dynamic content and renders Markdown into it.
	 * @param contentText The Markdown string to render.
	 * @param isRenderInHeader True if rendering in the header, false for footer.
	 * @param sourcePath The path of the file this content is for, used for Markdown rendering context.
	 * @returns A promise that resolves to an object containing the HTMLElement and its associated Component.
	 */
	private async prepareContentElement(
		contentText: string,
		isRenderInHeader: boolean,
		sourcePath: string
	): Promise<{ element: HTMLElement; component: Component }> {
		const contentDiv = document.createElement('div');
		contentDiv.className = CSS_DYNAMIC_CONTENT_ELEMENT;
		contentDiv.classList.add(isRenderInHeader ? CSS_HEADER_RENDERED_CONTENT : CSS_FOOTER_RENDERED_CONTENT);

		const component = new Component();
		component.load();
		(contentDiv as HTMLElementWithComponent).component = component;

		await MarkdownRenderer.render(this.app, contentText, contentDiv, sourcePath, component);
		return { element: contentDiv, component };
	}

	/** Applies specific CSS classes for Live Preview footer rendering to improve layout. */
	private applyLivePreviewFooterStyles(view: MarkdownView): void {
		const contentEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_AREA);
		const containerEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT);
		contentEl?.classList.add(CSS_VIRTUAL_FOOTER_CM_PADDING);
		containerEl?.classList.add(CSS_VIRTUAL_FOOTER_REMOVE_FLEX);
	}

	/** Removes CSS classes applied for Live Preview footer rendering. */
	private removeLivePreviewFooterStyles(viewOrContainer: MarkdownView | HTMLElement): void {
		const container = viewOrContainer instanceof MarkdownView ? viewOrContainer.containerEl : viewOrContainer;
		const contentEl = container.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_AREA);
		const containerEl = container.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT);
		contentEl?.classList.remove(CSS_VIRTUAL_FOOTER_CM_PADDING);
		containerEl?.classList.remove(CSS_VIRTUAL_FOOTER_REMOVE_FLEX);
	}

	/**
	 * Removes injected dynamic content elements from a given container element.
	 * It also unloads any associated components.
	 * @param containerEl The parent HTMLElement to search within.
	 */
	private async removeInjectedContentDOM(containerEl: HTMLElement): Promise<void> {
		SELECTORS_POTENTIAL_DYNAMIC_CONTENT_PARENTS.forEach(selector => {
			const parentEl = containerEl.querySelector(selector);
			parentEl?.querySelectorAll(`.${CSS_DYNAMIC_CONTENT_ELEMENT}`).forEach(el => {
				const componentHolder = el as HTMLElementWithComponent;
				if (componentHolder.component) {
					componentHolder.component.unload();
				}
				el.remove();
			});
		});
	}

	/**
	 * Removes all dynamic content (styles and DOM elements) from a specific view.
	 * @param view The MarkdownView to clean.
	 */
	private async removeDynamicContentFromView(view: MarkdownView): Promise<void> {
		this.removeLivePreviewFooterStyles(view);
		await this.removeInjectedContentDOM(view.containerEl);
	}

	/**
	 * Clears dynamic content from all open Markdown views.
	 * Used during plugin unload or when global settings change significantly.
	 */
	private clearAllViewsDynamicContent(): void {
		this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
			if (leaf.view instanceof MarkdownView) {
				this.removeDynamicContentFromView(leaf.view);
			}
		});
	}

	/**
	 * Determines all applicable rules and their content for a given file path.
	 * Rules are processed in the order they are defined in settings.
	 * @param filePath The path of the file to get content for.
	 * @returns A promise that resolves to an array of objects, each containing a matched Rule and its content string.
	 */
	private async _getApplicableRulesAndContent(filePath: string): Promise<Array<{ rule: Rule; contentText: string }>> {
		const allApplicable: Array<{ rule: Rule; contentText: string }> = [];
		const file = this.app.vault.getAbstractFileByPath(filePath);
		let fileTags: string[] | null = null;

		if (file instanceof TFile) {
			const fileCache = this.app.metadataCache.getFileCache(file);
			if (fileCache) {
				const allTagsInFileWithHash = getAllTags(fileCache);
				fileTags = allTagsInFileWithHash ? allTagsInFileWithHash.map(tag => tag.substring(1)) : [];
			}
		}

		for (const currentRule of this.settings.rules) {
			let isMatch = false;

			if (currentRule.type === RuleType.Folder && currentRule.path !== undefined) {
				if (currentRule.path === "") { // Empty string path rule applies to all files
					isMatch = true;
				} else if (currentRule.path === "/") { // Root folder path rule
					if (file instanceof TFile && file.parent?.isRoot()) {
						isMatch = true;
					}
				} else { // Regular folder path
					const normalizedRulePath = currentRule.path.endsWith('/') ? currentRule.path : currentRule.path + '/';
					if (filePath.startsWith(normalizedRulePath)) {
						isMatch = true;
					}
				}
			} else if (currentRule.type === RuleType.Tag && currentRule.tag && fileTags) {
				if (fileTags.includes(currentRule.tag)) {
					isMatch = true;
				}
			}

			if (isMatch) {
				const contentText = await this._fetchContentForRule(currentRule);
				// Add the rule and its content. renderAndInjectContent will handle empty contentText by not rendering.
				allApplicable.push({ rule: currentRule, contentText });
			}
		}
		return allApplicable;
	}

	/**
	 * Fetches the content for a given rule, either from its direct text or from a specified file.
	 * @param rule The rule to fetch content for.
	 * @returns A promise that resolves to the content string. Returns empty string if file not found or content is empty.
	 */
	private async _fetchContentForRule(rule: Rule): Promise<string> {
		if (rule.contentSource === ContentSource.File && rule.footerFilePath) {
			const file = this.app.vault.getAbstractFileByPath(rule.footerFilePath);
			if (file instanceof TFile) {
				return await this.app.vault.cachedRead(file);
			} else {
				console.warn(`VirtualFooter: Content file not found for rule: ${rule.footerFilePath}`);
				return "";
			}
		}
		return rule.footerText;
	}


	/**
	 * Attaches event handlers for internal links within the dynamically injected content.
	 * Handles left-clicks, Ctrl/Meta + left-clicks, and middle-clicks for opening links.
	 * @param container The HTMLElement containing the rendered Markdown.
	 * @param sourcePath The path of the file where the content is injected, for link resolution.
	 * @param component The component associated with this rendered content, to register DOM events.
	 */
	private attachInternalLinkHandlers(container: HTMLElement, sourcePath: string, component: Component): void {
		component.registerDomEvent(container, 'click', (event: MouseEvent) => {
			if (event.button !== 0) return;
			const target = event.target as HTMLElement;
			const link = target.closest('a.internal-link') as HTMLAnchorElement;
			if (link) {
				event.preventDefault();
				const href = link.dataset.href;
				if (href) {
					const newPane = event.ctrlKey || event.metaKey;
					this.app.workspace.openLinkText(href, sourcePath, newPane);
				}
			}
		});

		component.registerDomEvent(container, 'auxclick', (event: MouseEvent) => {
			if (event.button !== 1) return;
			const target = event.target as HTMLElement;
			const link = target.closest('a.internal-link') as HTMLAnchorElement;
			if (link) {
				event.preventDefault();
				const href = link.dataset.href;
				if (href) {
					this.app.workspace.openLinkText(href, sourcePath, true);
				}
			}
		});
	}

	/**
	 * Loads plugin settings from storage, performing migration from older formats if necessary.
	 */
	async loadSettings() {
		const loadedData = await this.loadData();
		this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); // Base on new defaults

		if (loadedData) {
			const oldGlobalRenderLocation = loadedData.renderLocation as RenderLocation | undefined;

			if (loadedData.rules && Array.isArray(loadedData.rules)) {
				this.settings.rules = loadedData.rules.map((loadedRule: any) =>
					this._migrateRule(loadedRule, oldGlobalRenderLocation)
				);
			}
		}

		if (!this.settings.rules || this.settings.rules.length === 0) {
			// DEFAULT_SETTINGS.rules[0] already includes renderLocation
			this.settings.rules = [JSON.parse(JSON.stringify(DEFAULT_SETTINGS.rules[0]))];
		} else {
			this.settings.rules.forEach(rule => this._normalizeRule(rule));
		}
	}

	/**
	 * Migrates a single rule object from a potentially older format to the current Rule interface.
	 * @param loadedRule The raw rule object loaded from data.
	 * @param globalRenderLocation The global render location from old settings, if available.
	 * @returns A migrated and partially normalized Rule object.
	 */
	private _migrateRule(loadedRule: any, globalRenderLocation?: RenderLocation): Rule {
		let type: RuleType;
		if (loadedRule.type === RuleType.Folder || loadedRule.type === RuleType.Tag) {
			type = loadedRule.type;
		} else if (typeof loadedRule.folderPath === 'string') {
			type = RuleType.Folder;
		} else {
			type = RuleType.Folder;
		}

		let contentSource: ContentSource;
		if (loadedRule.contentSource === ContentSource.Text || loadedRule.contentSource === ContentSource.File) {
			contentSource = loadedRule.contentSource;
		} else if (typeof loadedRule.folderPath === 'string' && loadedRule.contentSource === undefined) {
			contentSource = ContentSource.Text;
		} else {
			contentSource = ContentSource.Text;
		}

		const migratedRule: Rule = {
			type: type,
			contentSource: contentSource,
			footerText: loadedRule.footerText || '',
			renderLocation: loadedRule.renderLocation || globalRenderLocation || RenderLocation.Footer,
		};

		if (migratedRule.type === RuleType.Folder) {
			migratedRule.path = loadedRule.path !== undefined ? loadedRule.path :
				(loadedRule.folderPath !== undefined ? loadedRule.folderPath : '');
		} else {
			migratedRule.tag = loadedRule.tag !== undefined ? loadedRule.tag : '';
		}

		if (migratedRule.contentSource === ContentSource.File) {
			migratedRule.footerFilePath = loadedRule.footerFilePath || '';
		}

		return migratedRule;
	}

	/**
	 * Normalizes a rule to ensure all necessary fields are present and mutually exclusive fields are handled.
	 * This is called after migration or when new rules are created.
	 * @param rule The rule to normalize.
	 */
	private _normalizeRule(rule: Rule): void {
		rule.type = rule.type || RuleType.Folder;

		if (rule.type === RuleType.Folder) {
			rule.path = rule.path === undefined ? '' : rule.path;
			delete rule.tag;
		} else {
			rule.tag = rule.tag === undefined ? '' : rule.tag;
			delete rule.path;
		}

		rule.contentSource = rule.contentSource || ContentSource.Text;
		rule.footerText = rule.footerText || '';
		rule.renderLocation = rule.renderLocation || RenderLocation.Footer; // Ensure renderLocation

		if (rule.contentSource === ContentSource.File) {
			rule.footerFilePath = rule.footerFilePath || '';
		} else {
			delete rule.footerFilePath;
		}
	}

	/** Saves the current plugin settings to storage. */
	async saveSettings() {
		this.settings.rules.forEach(rule => this._normalizeRule(rule));
		await this.saveData(this.settings);
		this.handleActiveViewChange();
	}
}

/**
 * Setting tab for the VirtualFooter plugin.
 * Allows users to configure rules and rendering location.
 */
class VirtualFooterSettingTab extends PluginSettingTab {
	private allFolderPathsCache: Set<string> | null = null;
	private allTagsCache: Set<string> | null = null;
	private allMarkdownFilePathsCache: Set<string> | null = null;

	constructor(app: App, private plugin: VirtualFooterPlugin) {
		super(app, plugin);
	}

	/** Generates a set of all unique folder paths in the vault, including "/" for root. */
	private getAvailableFolderPaths(): Set<string> {
		if (this.allFolderPathsCache) return this.allFolderPathsCache;

		const paths = new Set<string>(['/']); // Add root by default
		this.app.vault.getAllLoadedFiles().forEach(file => {
			if (file instanceof TFile && file.parent) {
				const parentPath = file.parent.isRoot() ? '/' : (file.parent.path.endsWith('/') ? file.parent.path : file.parent.path + '/');
				if (parentPath !== '/') paths.add(parentPath); // Avoid adding root again if files are in root
			} else if ('children' in file && file.path !== '/') { // It's a folder
				const folderPath = file.path.endsWith('/') ? file.path : file.path + '/';
				paths.add(folderPath);
			}
		});
		this.allFolderPathsCache = paths;
		return paths;
	}

	/** Generates a set of all unique tags (without '#') present in the vault. */
	private getAvailableTags(): Set<string> {
		if (this.allTagsCache) return this.allTagsCache;

		const collectedTags = new Set<string>();
		this.app.vault.getMarkdownFiles().forEach(file => {
			const fileCache = this.app.metadataCache.getFileCache(file);
			if (fileCache) {
				const tagsInFile = getAllTags(fileCache);
				tagsInFile?.forEach(tag => {
					collectedTags.add(tag.substring(1));
				});
			}
		});
		this.allTagsCache = collectedTags;
		return collectedTags;
	}

	/** Generates a set of all Markdown file paths in the vault. */
	private getAvailableMarkdownFilePaths(): Set<string> {
		if (this.allMarkdownFilePathsCache) return this.allMarkdownFilePathsCache;

		const paths = new Set<string>();
		this.app.vault.getMarkdownFiles().forEach(file => {
			paths.add(file.path);
		});
		this.allMarkdownFilePathsCache = paths;
		return paths;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.allFolderPathsCache = null;
		this.allTagsCache = null;
		this.allMarkdownFilePathsCache = null;

		containerEl.createEl('h2', { text: 'Virtual Content Settings' });

		containerEl.createEl('h3', { text: 'Rules' });
		const rulesContainer = containerEl.createDiv('rules-container');

		if (!this.plugin.settings.rules) {
			this.plugin.settings.rules = [];
		}
		if (this.plugin.settings.rules.length === 0) {
			this.plugin.settings.rules.push(JSON.parse(JSON.stringify(DEFAULT_SETTINGS.rules[0])));
		}

		this.plugin.settings.rules.forEach((rule, index) => {
			this.renderRuleControls(rule, index, rulesContainer);
		});

		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('Add new rule')
				.setCta()
				.setClass('virtual-footer-add-button')
				.onClick(async () => {
					this.plugin.settings.rules.push(JSON.parse(JSON.stringify(DEFAULT_SETTINGS.rules[0])));
					await this.plugin.saveSettings();
					this.display();
				}));
	}

	/**
	 * Renders the UI controls for a single rule.
	 * @param rule The rule object to render controls for.
	 * @param index The index of the rule in the settings array.
	 * @param containerEl The HTML element to append the rule controls to.
	 */
	private renderRuleControls(rule: Rule, index: number, containerEl: HTMLElement): void {
		const ruleDiv = containerEl.createDiv('rule-item');
		ruleDiv.addClass('virtual-footer-rule-item');

		new Setting(ruleDiv)
			.setName(`Rule ${index + 1} type`)
			.addDropdown(dropdown => dropdown
				.addOption(RuleType.Folder, 'Folder')
				.addOption(RuleType.Tag, 'Tag')
				.setValue(rule.type)
				.onChange(async (value: string) => {
					rule.type = value as RuleType;
					if (rule.type === RuleType.Folder) {
						rule.path = rule.path ?? '';
						delete rule.tag;
					} else {
						rule.tag = rule.tag ?? '';
						delete rule.path;
					}
					await this.plugin.saveSettings();
					this.display();
				}));

		if (rule.type === RuleType.Folder) {
			new Setting(ruleDiv)
				.setName('Folder path')
				.setDesc('Path for the rule. Use "" for all files, "/" for root folder files, or "FolderName/" for specific folders and their subfolders.')
				.addText(text => {
					text.setPlaceholder('e.g., Meetings/, /, or empty for all')
						.setValue(rule.path || '')
						.onChange(async (value) => {
							rule.path = value;
							await this.plugin.saveSettings();
						});
					new MultiSuggest(text.inputEl, this.getAvailableFolderPaths(), (selectedPath) => {
						rule.path = selectedPath;
						text.setValue(selectedPath);
						this.plugin.saveSettings();
					}, this.plugin.app);
				});
		} else if (rule.type === RuleType.Tag) {
			new Setting(ruleDiv)
				.setName('Tag value')
				.setDesc('Tag to match (without the #).')
				.addText(text => {
					text.setPlaceholder('e.g., important or project/alpha')
						.setValue(rule.tag || '')
						.onChange(async (value) => {
							rule.tag = value.startsWith('#') ? value.substring(1) : value;
							await this.plugin.saveSettings();
						});
					new MultiSuggest(text.inputEl, this.getAvailableTags(), (selectedTag) => {
						const normalizedTag = selectedTag.startsWith('#') ? selectedTag.substring(1) : selectedTag;
						rule.tag = normalizedTag;
						text.setValue(normalizedTag);
						this.plugin.saveSettings();
					}, this.plugin.app);
				});
		}

		// --- Content Source (Text/File) ---
		new Setting(ruleDiv)
			.setName('Content source')
			.addDropdown(dropdown => dropdown
				.addOption(ContentSource.Text, 'Direct text')
				.addOption(ContentSource.File, 'Markdown file')
				.setValue(rule.contentSource || ContentSource.Text)
				.onChange(async (value: string) => {
					rule.contentSource = value as ContentSource;
					if (rule.contentSource === ContentSource.Text) {
						rule.footerText = rule.footerText ?? '';
						delete rule.footerFilePath;
					} else {
						rule.footerFilePath = rule.footerFilePath ?? '';
					}
					await this.plugin.saveSettings();
					this.display();
				}));

		// --- Source-Specific Input (Text Area or File Path) ---
		if (rule.contentSource === ContentSource.File) {
			new Setting(ruleDiv)
				.setName('Content file path')
				.setDesc('Path to the .md file to use as content.')
				.addText(text => {
					text.setPlaceholder('e.g., templates/footer-template.md')
						.setValue(rule.footerFilePath || '')
						.onChange(async (value) => {
							rule.footerFilePath = value;
							await this.plugin.saveSettings();
						});
					new MultiSuggest(text.inputEl, this.getAvailableMarkdownFilePaths(), (selectedPath) => {
						rule.footerFilePath = selectedPath;
						text.setValue(selectedPath);
						this.plugin.saveSettings();
					}, this.plugin.app);
				});
		} else {
			new Setting(ruleDiv)
				.setName('Content text')
				.setDesc('Markdown text to display.')
				.addTextArea(text => text
					.setPlaceholder('Enter your markdown content here...\nSupports multiple lines.')
					.setValue(rule.footerText || '')
					.onChange(async (value) => {
						rule.footerText = value;
						await this.plugin.saveSettings();
					}));
		}

		// --- Render Location (Header/Footer) for this rule ---
		new Setting(ruleDiv)
			.setName('Render location')
			.setDesc('Choose where this rule renders its content.')
			.addDropdown(dropdown => dropdown
				.addOption(RenderLocation.Footer, 'Footer')
				.addOption(RenderLocation.Header, 'Header')
				.setValue(rule.renderLocation || RenderLocation.Footer) // Default to Footer if somehow undefined
				.onChange(async (value: string) => {
					rule.renderLocation = value as RenderLocation;
					await this.plugin.saveSettings();
				}));


		// --- Delete Rule Button ---
		new Setting(ruleDiv)
			.addButton(button => button
				.setButtonText('Delete rule')
				.setWarning()
				.setClass('virtual-footer-delete-button')
				.onClick(async () => {
					this.plugin.settings.rules.splice(index, 1);
					await this.plugin.saveSettings();
					this.display();
				}));

		ruleDiv.createEl('hr', { cls: 'virtual-footer-rule-divider' });
	}
}
