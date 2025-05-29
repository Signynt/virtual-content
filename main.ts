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
 */
interface Rule {
	type: RuleType;
	path?: string; // For folder type: path to the folder, or "" for all files, or "/" for root
	tag?: string; // For tag type: the tag name (without '#')
	contentSource: ContentSource;
	footerText: string; // Direct text content if contentSource is 'text'
	footerFilePath?: string; // Path to .md file if contentSource is 'file'
}

/**
 * Defines the settings structure for the VirtualFooter plugin.
 */
interface VirtualFooterSettings {
	rules: Rule[];
	renderLocation: RenderLocation;
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
	rules: [{ type: RuleType.Folder, path: '', contentSource: ContentSource.Text, footerText: '' }],
	renderLocation: RenderLocation.Footer,
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
			// If no valid view or file, ensure all views are clean.
			// This might be redundant if called from handleActiveViewChange which focuses on one view,
			// but can be a safeguard.
			this.clearAllViewsDynamicContent();
			return;
		}

		// Clean up existing dynamic content and styles from this specific view first
		await this.removeDynamicContentFromView(view);

		const state = view.getState();
		const isRenderInHeader = this.settings.renderLocation === RenderLocation.Header;

		// Apply specific styles for Live Preview footer mode if applicable
		if (state.mode === 'source' && !state.source && !isRenderInHeader) { // Live Preview mode, footer rendering
			this.applyLivePreviewFooterStyles(view);
		}

		// Render and inject content if in Preview mode or Live Preview mode
		if (state.mode === 'preview' || (state.mode === 'source' && !state.source)) {
			await this.renderAndInjectContent(view);
		}
	}

	/**
	 * Renders the dynamic content based on rules and injects it into the specified view.
	 * @param view The MarkdownView to inject content into.
	 */
	private async renderAndInjectContent(view: MarkdownView): Promise<void> {
		const filePath = view.file?.path || '';
		const contentText = await this.getContentTextForFile(filePath);

		if (!contentText) {
			// If no content text, ensure any existing injected DOM is removed (should be handled by _processView's initial cleanup)
			// but as a safeguard:
			await this.removeInjectedContentDOM(view.containerEl);
			return;
		}

		const isRenderInHeader = this.settings.renderLocation === RenderLocation.Header;
		const { element: contentDiv, component } = await this.prepareContentElement(contentText, isRenderInHeader, filePath);

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
			this.attachInternalLinkHandlers(contentDiv, filePath, component);
		} else {
			// If injection failed, unload the component to prevent resource leaks
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

		// Create a new component for this dynamic content. This component will own the Markdown rendering.
		const component = new Component();
		component.load(); // Important: Load the component
		(contentDiv as HTMLElementWithComponent).component = component; // Store component for later cleanup

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
					componentHolder.component.unload(); // Unload the component
				}
				el.remove(); // Remove the element
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
	 * Determines the appropriate content text for a given file path based on the defined rules.
	 * Priority:
	 * 1. Most specific folder rule with non-empty content.
	 * 2. If no folder rule applies or its content is empty, the first matching tag rule (content can be empty).
	 * @param filePath The path of the file to get content for.
	 * @returns A promise that resolves to the content string, or an empty string if no rule matches or content is empty.
	 */
	private async getContentTextForFile(filePath: string): Promise<string> {
		let folderRuleContent = "";

		// 1. Determine the best matching folder rule and its content
		const bestFolderRule = this._findBestMatchingFolderRule(filePath);
		if (bestFolderRule) {
			folderRuleContent = await this._fetchContentForRule(bestFolderRule);
			// If folder rule provided non-empty text, return it immediately
			if (folderRuleContent) {
				return folderRuleContent;
			}
		}

		// 2. If no folder rule matched, or matched folder rule had empty content, check tag rules
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			const fileCache = this.app.metadataCache.getFileCache(file);
			if (fileCache) {
				const allTagsInFileWithHash = getAllTags(fileCache);
				const fileTags = allTagsInFileWithHash ? allTagsInFileWithHash.map(tag => tag.substring(1)) : [];

				for (const rule of this.settings.rules) {
					if (rule.type === RuleType.Tag && rule.tag && fileTags.includes(rule.tag)) {
						// First matching tag rule determines the content
						return await this._fetchContentForRule(rule);
					}
				}
			}
		}

		// 3. If no rules matched or provided text, return empty string (or empty content from folder rule)
		return folderRuleContent; // This will be "" if folder rule was empty or no folder rule matched
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
					if (filePath.startsWith(normalizedRulePath) || filePath.startsWith(rule.path + '/')) { // Check both with and without trailing slash for robustness
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
				return ""; // File not found, treat as empty content
			}
		}
		return rule.footerText; // contentSource is 'text' or fallback
	}


	/**
	 * Attaches event handlers for internal links within the dynamically injected content.
	 * Handles left-clicks, Ctrl/Meta + left-clicks, and middle-clicks for opening links.
	 * @param container The HTMLElement containing the rendered Markdown.
	 * @param sourcePath The path of the file where the content is injected, for link resolution.
	 * @param component The component associated with this rendered content, to register DOM events.
	 */
	private attachInternalLinkHandlers(container: HTMLElement, sourcePath: string, component: Component): void {
		// Handle left-clicks and Ctrl/Meta + left-clicks
		component.registerDomEvent(container, 'click', (event: MouseEvent) => {
			if (event.button !== 0) return; // Only handle left-clicks
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

		// Handle middle-clicks (typically button 1)
		component.registerDomEvent(container, 'auxclick', (event: MouseEvent) => {
			if (event.button !== 1) return; // Only handle middle-clicks
			const target = event.target as HTMLElement;
			const link = target.closest('a.internal-link') as HTMLAnchorElement;
			if (link) {
				event.preventDefault();
				const href = link.dataset.href;
				if (href) {
					// Middle-click always opens in a new pane
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
		// Start with a deep copy of default settings to ensure all fields are present
		this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

		if (loadedData) {
			// Migrate renderLocation
			this.settings.renderLocation = (loadedData.renderLocation as RenderLocation) || DEFAULT_SETTINGS.renderLocation;

			// Migrate rules
			if (loadedData.rules && Array.isArray(loadedData.rules)) {
				this.settings.rules = loadedData.rules.map((loadedRule: any) => this._migrateRule(loadedRule));
			}
		}

		// Ensure there's at least one rule if rules array is empty after loading/migration
		if (!this.settings.rules || this.settings.rules.length === 0) {
			this.settings.rules = [{ type: RuleType.Folder, path: '', contentSource: ContentSource.Text, footerText: '' }];
		} else {
			// Final cleanup pass for each rule to ensure data integrity
			this.settings.rules.forEach(rule => this._normalizeRule(rule));
		}
	}

	/**
	 * Migrates a single rule object from a potentially older format to the current Rule interface.
	 * @param loadedRule The raw rule object loaded from data.
	 * @returns A migrated and partially normalized Rule object.
	 */
	private _migrateRule(loadedRule: any): Rule {
		let type: RuleType;
		if (loadedRule.type === RuleType.Folder || loadedRule.type === RuleType.Tag) {
			type = loadedRule.type;
		} else if (typeof loadedRule.folderPath === 'string') { // Legacy: 'folderPath' implies 'folder' type
			type = RuleType.Folder;
		} else {
			type = RuleType.Folder; // Default to folder if type is missing or invalid
		}

		let contentSource: ContentSource;
		if (loadedRule.contentSource === ContentSource.Text || loadedRule.contentSource === ContentSource.File) {
			contentSource = loadedRule.contentSource;
		} else if (typeof loadedRule.folderPath === 'string' && loadedRule.contentSource === undefined) {
			// Legacy rule (had folderPath, no contentSource) was implicitly 'text'
			contentSource = ContentSource.Text;
		} else {
			contentSource = ContentSource.Text; // Default to text if missing or invalid
		}

		const migratedRule: Rule = {
			type: type,
			contentSource: contentSource,
			footerText: loadedRule.footerText || '',
		};

		if (migratedRule.type === RuleType.Folder) {
			// Handle 'path' and legacy 'folderPath'
			migratedRule.path = loadedRule.path !== undefined ? loadedRule.path :
				(loadedRule.folderPath !== undefined ? loadedRule.folderPath : '');
		} else { // RuleType.Tag
			migratedRule.tag = loadedRule.tag !== undefined ? loadedRule.tag : '';
		}

		if (migratedRule.contentSource === ContentSource.File) {
			migratedRule.footerFilePath = loadedRule.footerFilePath || '';
		}
		// footerText is always present on migratedRule, initialized with loadedRule.footerText or ''

		return migratedRule;
	}

	/**
	 * Normalizes a rule to ensure all necessary fields are present and mutually exclusive fields are handled.
	 * This is called after migration or when new rules are created.
	 * @param rule The rule to normalize.
	 */
	private _normalizeRule(rule: Rule): void {
		rule.type = rule.type || RuleType.Folder; // Should be set by migration, but as a fallback

		if (rule.type === RuleType.Folder) {
			rule.path = rule.path === undefined ? '' : rule.path;
			delete rule.tag; // Ensure tag is not present for folder type
		} else { // RuleType.Tag
			rule.tag = rule.tag === undefined ? '' : rule.tag;
			delete rule.path; // Ensure path is not present for tag type
		}

		rule.contentSource = rule.contentSource || ContentSource.Text;
		rule.footerText = rule.footerText || ''; // Ensure footerText is always a string

		if (rule.contentSource === ContentSource.File) {
			rule.footerFilePath = rule.footerFilePath || '';
		} else { // ContentSource.Text
			delete rule.footerFilePath; // Ensure footerFilePath is not present for text source
		}
	}

	/** Saves the current plugin settings to storage. */
	async saveSettings() {
		// Before saving, ensure all rules are normalized
		this.settings.rules.forEach(rule => this._normalizeRule(rule));
		await this.saveData(this.settings);
		// After saving, it's good practice to refresh the view if settings affect display
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

		const paths = new Set<string>(['/']); // Add root path by default
		this.app.vault.getAllLoadedFiles().forEach(file => {
			if (file instanceof TFile && file.parent) { // File has a parent folder
				const parentPath = file.parent.isRoot() ? '/' : (file.parent.path.endsWith('/') ? file.parent.path : file.parent.path + '/');
				if (parentPath !== '/') paths.add(parentPath); // Add normalized parent path
			} else if ('children' in file && file.path !== '/') { // It's a folder itself (and not root)
				const folderPath = file.path.endsWith('/') ? file.path : file.path + '/';
				paths.add(folderPath); // Add normalized folder path
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
				const tagsInFile = getAllTags(fileCache); // Returns tags with '#'
				tagsInFile?.forEach(tag => {
					collectedTags.add(tag.substring(1)); // Store without '#'
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
			paths.add(file.path); // Store full path
		});
		this.allMarkdownFilePathsCache = paths;
		return paths;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Invalidate caches on display, as vault contents might have changed
		this.allFolderPathsCache = null;
		this.allTagsCache = null;
		this.allMarkdownFilePathsCache = null;

		containerEl.createEl('h2', { text: 'Virtual Content Settings' });

		// Setting for render location (Header/Footer)
		new Setting(containerEl)
			.setName('Render location')
			.setDesc('Choose where to render the dynamic content in the view.')
			.addDropdown(dropdown => dropdown
				.addOption(RenderLocation.Footer, 'Footer')
				.addOption(RenderLocation.Header, 'Header')
				.setValue(this.plugin.settings.renderLocation)
				.onChange(async (value: string) => {
					this.plugin.settings.renderLocation = value as RenderLocation;
					await this.plugin.saveSettings();
					// No need to call handleActiveViewChange here, saveSettings does it.
				}));

		containerEl.createEl('h3', { text: 'Rules' });
		const rulesContainer = containerEl.createDiv('rules-container');

		// Ensure rules array exists and has at least one default rule if empty
		if (!this.plugin.settings.rules) {
			this.plugin.settings.rules = [];
		}
		if (this.plugin.settings.rules.length === 0) {
			this.plugin.settings.rules.push({ type: RuleType.Folder, path: '', contentSource: ContentSource.Text, footerText: '' });
		}

		this.plugin.settings.rules.forEach((rule, index) => {
			this.renderRuleControls(rule, index, rulesContainer);
		});

		// Button to add a new rule
		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('Add new rule')
				.setCta() // Makes it more prominent
				.setClass('virtual-footer-add-button')
				.onClick(async () => {
					this.plugin.settings.rules.push({ type: RuleType.Folder, path: '', contentSource: ContentSource.Text, footerText: '' });
					await this.plugin.saveSettings();
					this.display(); // Re-render the settings tab
					// No need to call handleActiveViewChange here, saveSettings does it.
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
		ruleDiv.addClass('virtual-footer-rule-item'); // For styling

		// --- Rule Type (Folder/Tag) ---
		new Setting(ruleDiv)
			.setName(`Rule ${index + 1} type`)
			.addDropdown(dropdown => dropdown
				.addOption(RuleType.Folder, 'Folder')
				.addOption(RuleType.Tag, 'Tag')
				.setValue(rule.type)
				.onChange(async (value: string) => {
					rule.type = value as RuleType;
					// Reset specific fields when type changes to maintain data integrity
					if (rule.type === RuleType.Folder) {
						rule.path = rule.path ?? '';
						delete rule.tag;
					} else { // Tag
						rule.tag = rule.tag ?? '';
						delete rule.path;
					}
					await this.plugin.saveSettings();
					this.display(); // Re-render to show correct fields
				}));

		// --- Type-Specific Input (Folder Path or Tag Value) ---
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
						text.setValue(selectedPath); // Update text field visually
						this.plugin.saveSettings(); // Auto-save on selection
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
							rule.tag = value.startsWith('#') ? value.substring(1) : value; // Normalize: remove leading #
							await this.plugin.saveSettings();
						});
					new MultiSuggest(text.inputEl, this.getAvailableTags(), (selectedTag) => {
						const normalizedTag = selectedTag.startsWith('#') ? selectedTag.substring(1) : selectedTag;
						rule.tag = normalizedTag;
						text.setValue(normalizedTag); // Update text field visually
						this.plugin.saveSettings(); // Auto-save on selection
					}, this.plugin.app);
				});
		}

		// --- Content Source (Text/File) ---
		new Setting(ruleDiv)
			.setName('Content source')
			.addDropdown(dropdown => dropdown
				.addOption(ContentSource.Text, 'Direct text')
				.addOption(ContentSource.File, 'Markdown file')
				.setValue(rule.contentSource || ContentSource.Text) // Default to 'text'
				.onChange(async (value: string) => {
					rule.contentSource = value as ContentSource;
					// Reset specific fields when source changes
					if (rule.contentSource === ContentSource.Text) {
						rule.footerText = rule.footerText ?? '';
						delete rule.footerFilePath;
					} else { // File
						rule.footerFilePath = rule.footerFilePath ?? '';
						// Optionally, clear footerText or keep it as a fallback if file is not found?
						// Current logic: footerText is only used if source is Text.
					}
					await this.plugin.saveSettings();
					this.display(); // Re-render to show correct fields
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
						text.setValue(selectedPath); // Update text field visually
						this.plugin.saveSettings(); // Auto-save on selection
					}, this.plugin.app);
				});
		} else { // ContentSource.Text (or undefined, defaults to text)
			new Setting(ruleDiv)
				.setName('Content text')
				.setDesc('Markdown text to display.')
				.addTextArea(text => text
					.setPlaceholder('Enter your markdown content here...\nSupports multiple lines.')
					.setValue(rule.footerText || '') // footerText should be initialized
					.onChange(async (value) => {
						rule.footerText = value;
						await this.plugin.saveSettings();
					}));
		}

		// --- Delete Rule Button ---
		new Setting(ruleDiv)
			.addButton(button => button
				.setButtonText('Delete rule')
				.setWarning() // Indicates a destructive action
				.setClass('virtual-footer-delete-button')
				.onClick(async () => {
					this.plugin.settings.rules.splice(index, 1);
					await this.plugin.saveSettings();
					this.display(); // Re-render the settings tab
				}));

		ruleDiv.createEl('hr', { cls: 'virtual-footer-rule-divider' }); // Visual separator for rules
	}
}
