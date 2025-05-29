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
	// renderLocation: RenderLocation; // Removed global renderLocation
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
	// renderLocation: RenderLocation.Footer, // Removed global renderLocation
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

		await this.removeDynamicContentFromView(view);

		const { rule: applicableRule, contentText } = await this._getApplicableRuleAndContent(view.file.path);

		if (!applicableRule) {
			// No rule applies. removeDynamicContentFromView handled cleanup.
			// renderAndInjectContent will not be called if contentText is empty (which it will be).
			return;
		}

		// A rule (applicableRule) applies.
		const isRenderInHeader = applicableRule.renderLocation === RenderLocation.Header;
		const state = view.getState();

		// Apply specific styles ONLY IF this rule will render in the footer in Live Preview.
		if (state.mode === 'source' && !state.source && !isRenderInHeader) { // Live Preview mode, footer rendering
			this.applyLivePreviewFooterStyles(view);
		}

		// Render and inject content if in Preview mode or Live Preview mode.
		// renderAndInjectContent will bail if contentText is empty.
		if (state.mode === 'preview' || (state.mode === 'source' && !state.source)) {
			await this.renderAndInjectContent(view, contentText, applicableRule.renderLocation);
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
			await this.removeInjectedContentDOM(view.containerEl); // Safeguard
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
			console.warn("VirtualFooter: Failed to find injection point for dynamic content.");
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
	 * Determines the applicable rule and its content for a given file path.
	 * Priority:
	 * 1. Most specific folder rule with non-empty content.
	 * 2. If no folder rule applies or its content is empty, the first matching tag rule (content can be empty).
	 * @param filePath The path of the file to get content for.
	 * @returns A promise that resolves to an object containing the matched Rule and its content string.
	 *          Returns { rule: null, contentText: "" } if no rule matches or applicable rule has no content.
	 */
	private async _getApplicableRuleAndContent(filePath: string): Promise<{ rule: Rule | null; contentText: string }> {
		// 1. Find best folder rule and its content
		const bestFolderRule = this._findBestMatchingFolderRule(filePath);
		let folderRuleContent = "";
		if (bestFolderRule) {
			folderRuleContent = await this._fetchContentForRule(bestFolderRule);
			if (folderRuleContent) {
				// Folder rule has content, this is the one.
				return { rule: bestFolderRule, contentText: folderRuleContent };
			}
		}

		// 2. If folder rule didn't apply, or its content was empty, check tags.
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			const fileCache = this.app.metadataCache.getFileCache(file);
			if (fileCache) {
				const allTagsInFileWithHash = getAllTags(fileCache);
				const fileTags = allTagsInFileWithHash ? allTagsInFileWithHash.map(tag => tag.substring(1)) : [];

				for (const currentRule of this.settings.rules) {
					if (currentRule.type === RuleType.Tag && currentRule.tag && fileTags.includes(currentRule.tag)) {
						// First matching tag rule.
						const tagRuleContent = await this._fetchContentForRule(currentRule);
						return { rule: currentRule, contentText: tagRuleContent };
					}
				}
			}
		}

		// 3. If we reach here:
		//    - No folder rule with content was found.
		//    - No tag rule was found.
		//    - However, a folder rule *might* have matched but had empty content.
		//      In this case, that folder rule (and its empty content) should be returned.
		if (bestFolderRule) { // This implies folderRuleContent was ""
			return { rule: bestFolderRule, contentText: folderRuleContent }; // folderRuleContent is ""
		}

		// No rule matched at all.
		return { rule: null, contentText: "" };
	}


	/**
	 * Finds the most specific folder rule that applies to the given file path.
	 * @param filePath The path of the file.
	 * @returns The best matching Rule object, or null if no folder rule applies.
	 */
	private _findBestMatchingFolderRule(filePath: string): Rule | null {
		let bestMatchRule: Rule | null = null;
		let bestMatchSpecificity = -1;

		for (const rule of this.settings.rules) {
			if (rule.type === RuleType.Folder && rule.path !== undefined) {
				let isMatch = false;
				let currentRuleSpecificity = -1;

				if (rule.path === "") { // Empty string path rule applies to all files
					isMatch = true;
					currentRuleSpecificity = 0; // Least specific
				} else if (rule.path === "/") { // Root folder path rule
					const fileForPath = this.app.vault.getAbstractFileByPath(filePath);
					if (fileForPath instanceof TFile && fileForPath.parent?.isRoot()) {
						isMatch = true;
						currentRuleSpecificity = 1; // More specific than ""
					}
				} else { // Regular folder path (e.g., "Meetings/")
					const normalizedRulePath = rule.path.endsWith('/') ? rule.path : rule.path + '/';
					if (filePath.startsWith(normalizedRulePath) || filePath.startsWith(rule.path + '/')) {
						isMatch = true;
						currentRuleSpecificity = rule.path.length;
					}
				}

				if (isMatch && currentRuleSpecificity > bestMatchSpecificity) {
					bestMatchSpecificity = currentRuleSpecificity;
					bestMatchRule = rule;
				}
			}
		}
		return bestMatchRule;
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

		const paths = new Set<string>(['/']);
		this.app.vault.getAllLoadedFiles().forEach(file => {
			if (file instanceof TFile && file.parent) {
				const parentPath = file.parent.isRoot() ? '/' : (file.parent.path.endsWith('/') ? file.parent.path : file.parent.path + '/');
				if (parentPath !== '/') paths.add(parentPath);
			} else if ('children' in file && file.path !== '/') {
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

		// Removed global render location setting

		containerEl.createEl('h3', { text: 'Rules' });
		const rulesContainer = containerEl.createDiv('rules-container');

		if (!this.plugin.settings.rules) {
			this.plugin.settings.rules = [];
		}
		if (this.plugin.settings.rules.length === 0) {
			// DEFAULT_SETTINGS.rules[0] now includes renderLocation
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
					// Add a new rule with default renderLocation from DEFAULT_SETTINGS
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
					// No need to call this.display() as only this rule's state changes,
					// and saveSettings() will trigger handleActiveViewChange for visual update.
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

