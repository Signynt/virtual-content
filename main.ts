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
/** Defines the type of a rule, determining how it matches files (e.g., by folder or tag). */
enum RuleType {
	Folder = 'folder',
	Tag = 'tag',
}

/** Defines the source of the content for a rule (e.g., direct text input or a markdown file). */
enum ContentSource {
	Text = 'text',
	File = 'file',
}

/** Defines where the dynamic content should be rendered within the Markdown view (e.g., header or footer). */
enum RenderLocation {
	Footer = 'footer',
	Header = 'header',
}

// --- Interfaces ---

/**
 * Represents a rule for injecting dynamic content into Markdown views.
 * Each rule specifies matching criteria (type: folder/tag), content source (text/file),
 * the content itself, and where it should be rendered (header/footer).
 */
interface Rule {
	/** The type of criteria for this rule (folder-based or tag-based). */
	type: RuleType;
	/** For 'folder' type: path to the folder. "" for all files, "/" for root. */
	path?: string;
	/** For 'tag' type: the tag name (without '#'). */
	tag?: string;
	/** For 'folder' type: whether to match subfolders. Defaults to true. Ignored if path is "". */
	recursive?: boolean;
	/** For 'tag' type: whether to match subtags (e.g., 'tag' matches 'tag/subtag'). Defaults to false. */
	includeSubtags?: boolean;
	/** The source from which to get the content (direct text or a file). */
	contentSource: ContentSource;
	/** Direct text content if contentSource is 'text'. */
	footerText: string; // Retained name for compatibility, but applies to header/footer
	/** Path to a .md file if contentSource is 'file'. */
	footerFilePath?: string; // Retained name for compatibility
	/** Specifies whether to render in the header or footer. */
	renderLocation: RenderLocation;
}

/**
 * Defines the settings structure for the VirtualFooter plugin.
 * Contains an array of rules that dictate content injection.
 */
interface VirtualFooterSettings {
	rules: Rule[];
}

/**
 * Extends HTMLElement to associate an Obsidian Component for lifecycle management.
 * For dynamically injected content that includes Markdown rendering
 * or requires event handling, ensuring proper cleanup when the content is removed.
 */
interface HTMLElementWithComponent extends HTMLElement {
	/** The Obsidian Component associated with this DOM element for lifecycle management. */
	component?: Component;
}

// --- Constants ---

/** Default settings for the plugin, used when no settings are found or for new rules. */
const DEFAULT_SETTINGS: VirtualFooterSettings = {
	rules: [{
		type: RuleType.Folder,
		path: '', // Applies to all files by default
		recursive: true, // Default to recursive for new folder rules
		contentSource: ContentSource.Text,
		footerText: '', // Empty content by default
		renderLocation: RenderLocation.Footer, // Default to footer
		// includeSubtags is not applicable for Folder type, normalizeRule will handle it.
	}],
};

// CSS Classes for styling and identifying plugin-generated elements
const CSS_DYNAMIC_CONTENT_ELEMENT = 'virtual-footer-dynamic-content-element'; // General class for all injected content groups
const CSS_HEADER_GROUP_ELEMENT = 'virtual-footer-header-group'; // Class for header content groups
const CSS_FOOTER_GROUP_ELEMENT = 'virtual-footer-footer-group'; // Class for footer content groups
const CSS_HEADER_RENDERED_CONTENT = 'virtual-footer-header-rendered-content'; // Applied to rendered header content (may be redundant with group element)
const CSS_FOOTER_RENDERED_CONTENT = 'virtual-footer-footer-rendered-content'; // Applied to rendered footer content (may be redundant with group element)
const CSS_VIRTUAL_FOOTER_CM_PADDING = 'virtual-footer-cm-padding'; // Adds padding for Live Preview footer spacing
const CSS_VIRTUAL_FOOTER_REMOVE_FLEX = 'virtual-footer-remove-flex'; // Modifies flex behavior for Live Preview footer styling

// DOM Selectors for finding injection points or elements to modify
const SELECTOR_EDITOR_CONTENT_AREA = '.cm-editor .cm-content'; // Live Preview: content text area
const SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT = '.markdown-source-view.mod-cm6 .cm-contentContainer'; // Live Preview: parent of content container for styling
const SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER = '.cm-contentContainer'; // Live Preview: target for header injection
const SELECTOR_EDITOR_SIZER = '.cm-sizer'; // Live Preview: target for footer injection
const SELECTOR_PREVIEW_HEADER_AREA = '.mod-header.mod-ui'; // Reading mode: header area
const SELECTOR_PREVIEW_FOOTER_AREA = '.mod-footer'; // Reading mode: footer area

// Selectors for finding parent elements of potentially injected dynamic content, used for cleanup.
// Includes current and legacy selectors to ensure thorough removal.
const SELECTORS_POTENTIAL_DYNAMIC_CONTENT_PARENTS = [
	SELECTOR_EDITOR_SIZER,                     // Live Preview footer parent
	SELECTOR_PREVIEW_FOOTER_AREA,              // Reading mode footer parent
	SELECTOR_PREVIEW_HEADER_AREA,              // Reading mode header parent
	SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER,   // Live Preview header parent (actually its parent is used for insertion)
	'.metadata-container .metadata-content',   // Legacy selector for cleanup
	'.view-header',                            // Legacy selector for cleanup
];

// --- Utility Classes ---

/**
 * Provides autocompletion suggestions for an input field from a predefined set of strings.
 */
export class MultiSuggest extends AbstractInputSuggest<string> {
	/**
	 * Creates an instance of MultiSuggest.
	 * @param inputEl The HTML input element to attach suggestions to.
	 * @param content A Set of strings to use as suggestions.
	 * @param onSelectCb Callback function executed when a suggestion is selected.
	 * @param app The Obsidian App instance.
	 */
	constructor(
		private inputEl: HTMLInputElement,
		private content: Set<string>,
		private onSelectCb: (value: string) => void,
		app: App
	) {
		super(app, inputEl);
	}

	/**
	 * Filters the content set to find suggestions matching the input string.
	 * @param inputStr The current string in the input field.
	 * @returns An array of matching suggestion strings.
	 */
	getSuggestions(inputStr: string): string[] {
		const lowerCaseInputStr = inputStr.toLocaleLowerCase();
		return [...this.content].filter((contentItem) =>
			contentItem.toLocaleLowerCase().includes(lowerCaseInputStr)
		);
	}

	/**
	 * Renders a single suggestion item in the suggestion list.
	 * @param content The suggestion string to render.
	 * @param el The HTMLElement to render the suggestion into.
	 */
	renderSuggestion(content: string, el: HTMLElement): void {
		el.setText(content);
	}

	/**
	 * Handles the selection of a suggestion.
	 * Updates the input field, calls the onSelect callback, and closes the suggestion list.
	 * @param content The selected suggestion string.
	 * @param _evt The mouse or keyboard event that triggered the selection.
	 */
	selectSuggestion(content: string, _evt: MouseEvent | KeyboardEvent): void {
		this.onSelectCb(content);
		this.inputEl.value = content;
		this.inputEl.blur();
		this.close();
	}
}

// --- Main Plugin Class ---

export default class VirtualFooterPlugin extends Plugin {
	settings: VirtualFooterSettings;

	/**
	 * Called when the plugin is loaded.
	 * Initializes settings, adds the setting tab, and registers event listeners.
	 */
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new VirtualFooterSettingTab(this.app, this));

		// Refresh dynamic content when a file is opened or the layout changes
		this.registerEvent(
			this.app.workspace.on('file-open', this.handleActiveViewChange)
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', this.handleActiveViewChange)
		);

		// Process the currently active view on load
		this.handleActiveViewChange();
	}

	/**
	 * Called when the plugin is unloaded.
	 * Cleans up all injected content and styles from all views.
	 */
	async onunload() {
		// Attempt to clean up content from all known markdown views
		this.clearAllViewsDynamicContent();

		// Fallback: Perform a global search and remove any remaining dynamic content elements.
		// This acts as a safety net for elements not caught by view-specific cleanup.
		document.querySelectorAll(`.${CSS_DYNAMIC_CONTENT_ELEMENT}`).forEach(el => {
			const componentHolder = el as HTMLElementWithComponent;
			if (componentHolder.component) {
				componentHolder.component.unload(); // Unload associated component
			}
			el.remove(); // Remove the DOM element
		});

		// Fallback: Remove global CSS classes that might have been applied.
		document.querySelectorAll(`.${CSS_VIRTUAL_FOOTER_CM_PADDING}`).forEach(el => el.classList.remove(CSS_VIRTUAL_FOOTER_CM_PADDING));
		document.querySelectorAll(`.${CSS_VIRTUAL_FOOTER_REMOVE_FLEX}`).forEach(el => el.classList.remove(CSS_VIRTUAL_FOOTER_REMOVE_FLEX));
	}

	/**
	 * Event handler for 'file-open' and 'layout-change' events.
	 * Triggers processing of the currently active Markdown view.
	 * Bound with `this` context in `onload`.
	 */
	private handleActiveViewChange = () => {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		this._processView(activeView);
	}

	/**
	 * Processes a given Markdown view to apply or remove dynamic content.
	 * This is the core logic for updating views based on rules.
	 * @param view The MarkdownView to process, or null if no Markdown view is active.
	 */
	private async _processView(view: MarkdownView | null): Promise<void> {
		if (!view || !view.file) {
			// If no valid view or file, ensure any existing dynamic content in other views is cleared (e.g., if settings changed)
			return;
		}

		// Always remove existing dynamic content from this specific view before re-processing
		await this.removeDynamicContentFromView(view);

		const applicableRulesWithContent = await this._getApplicableRulesAndContent(view.file.path);

		if (applicableRulesWithContent.length === 0) {
			return; // No rules apply to this file, and cleanup is already done.
		}

		const viewState = view.getState();
		let combinedHeaderText = "";
		let combinedFooterText = "";
		let hasFooterRule = false;
		const contentSeparator = "\n\n"; // Markdown paragraph break

		for (const { rule, contentText } of applicableRulesWithContent) {
			if (!contentText || contentText.trim() === "") continue;

			if (rule.renderLocation === RenderLocation.Header) {
				combinedHeaderText += (combinedHeaderText ? contentSeparator : "") + contentText;
			} else {
				combinedFooterText += (combinedFooterText ? contentSeparator : "") + contentText;
				hasFooterRule = true;
			}
		}

		// Apply specific Live Preview footer styles if footer content exists and view is in Live Preview mode.
		if (viewState.mode === 'source' && !viewState.source && hasFooterRule) {
			this.applyLivePreviewFooterStyles(view);
		}

		// Render and inject content groups if in Reading mode or Live Preview mode.
		// 'source' && !'source' means Live Preview. 'preview' means Reading mode.
		if (viewState.mode === 'preview' || (viewState.mode === 'source' && !viewState.source)) {
			if (combinedHeaderText.trim()) {
				await this.renderAndInjectGroupedContent(view, combinedHeaderText, RenderLocation.Header);
			}
			if (combinedFooterText.trim()) {
				await this.renderAndInjectGroupedContent(view, combinedFooterText, RenderLocation.Footer);
			}
		}
	}

	/**
	 * Renders combined Markdown content into a group element and injects it into the view.
	 * @param view The MarkdownView to inject content into.
	 * @param combinedContentText The combined Markdown text to render.
	 * @param renderLocation Specifies whether to render in the Header or Footer.
	 */
	private async renderAndInjectGroupedContent(view: MarkdownView, combinedContentText: string, renderLocation: RenderLocation): Promise<void> {
		if (!combinedContentText || combinedContentText.trim() === "") {
			return;
		}

		const isRenderInHeader = renderLocation === RenderLocation.Header;
		const sourcePath = view.file?.path || ''; // Source path for Markdown rendering context

		// Create the main container div for the dynamic content
		const groupDiv = document.createElement('div') as HTMLElementWithComponent;
		groupDiv.className = CSS_DYNAMIC_CONTENT_ELEMENT; // General class for identification
		groupDiv.classList.add(
			isRenderInHeader ? CSS_HEADER_GROUP_ELEMENT : CSS_FOOTER_GROUP_ELEMENT,
			isRenderInHeader ? CSS_HEADER_RENDERED_CONTENT : CSS_FOOTER_RENDERED_CONTENT
		);

		// Create and load an Obsidian Component to manage the lifecycle of the rendered content
		const component = new Component();
		component.load();
		groupDiv.component = component; // Associate component with the element

		// Render the Markdown content into the groupDiv
		await MarkdownRenderer.render(this.app, combinedContentText, groupDiv, sourcePath, component);

		let injectionSuccessful = false;
		const viewState = view.getState();

		if (viewState.mode === 'preview') { // Reading mode
			const previewContentParent = view.previewMode.containerEl;
			const targetParent = previewContentParent.querySelector<HTMLElement>(
				isRenderInHeader ? SELECTOR_PREVIEW_HEADER_AREA : SELECTOR_PREVIEW_FOOTER_AREA
			);
			if (targetParent) {
				targetParent.appendChild(groupDiv);
				injectionSuccessful = true;
			}
		} else if (viewState.mode === 'source' && !viewState.source) { // Live Preview editor mode
			if (isRenderInHeader) {
				const cmContentContainer = view.containerEl.querySelector<HTMLElement>(SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER);
				if (cmContentContainer?.parentElement) {
					cmContentContainer.parentElement.insertBefore(groupDiv, cmContentContainer);
					injectionSuccessful = true;
				}
			} else { 
				const targetParent = view.containerEl.querySelector<HTMLElement>(SELECTOR_EDITOR_SIZER);
				if (targetParent) {
					targetParent.appendChild(groupDiv);
					injectionSuccessful = true;
				}
			}
		}

		if (injectionSuccessful) {
			this.attachInternalLinkHandlers(groupDiv, sourcePath, component);
		} else {
			component.unload(); 
			console.warn(`VirtualFooter: Failed to find injection point for dynamic content group (${renderLocation}). View mode: ${viewState.mode}.`);
		}
	}

	/**
	 * Applies specific CSS classes to improve layout for Live Preview footer rendering.
	 * @param view The MarkdownView in Live Preview mode.
	 */
	private applyLivePreviewFooterStyles(view: MarkdownView): void {
		const contentEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_AREA);
		const containerEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT);
		contentEl?.classList.add(CSS_VIRTUAL_FOOTER_CM_PADDING);
		containerEl?.classList.add(CSS_VIRTUAL_FOOTER_REMOVE_FLEX);
	}

	/**
	 * Removes CSS classes applied for Live Preview footer rendering.
	 * @param viewOrContainer The MarkdownView or a generic HTMLElement to remove styles from.
	 */
	private removeLivePreviewFooterStyles(viewOrContainer: MarkdownView | HTMLElement): void {
		const container = viewOrContainer instanceof MarkdownView ? viewOrContainer.containerEl : viewOrContainer;
		const contentEl = container.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_AREA);
		const containerEl = container.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT);
		contentEl?.classList.remove(CSS_VIRTUAL_FOOTER_CM_PADDING);
		containerEl?.classList.remove(CSS_VIRTUAL_FOOTER_REMOVE_FLEX);
	}

	/**
	 * Removes injected dynamic content DOM elements from a given container.
	 * It searches within known parent selectors and unloads any associated Obsidian Components.
	 * @param containerEl The parent HTMLElement to search within for dynamic content.
	 */
	private async removeInjectedContentDOM(containerEl: HTMLElement): Promise<void> {
		SELECTORS_POTENTIAL_DYNAMIC_CONTENT_PARENTS.forEach(selector => {
			const parentElements = containerEl.querySelectorAll(selector); 
			parentElements.forEach(parentEl => { 
				parentEl.querySelectorAll(`.${CSS_DYNAMIC_CONTENT_ELEMENT}`).forEach(el => {
					const componentHolder = el as HTMLElementWithComponent;
					if (componentHolder.component) {
						componentHolder.component.unload(); 
					}
					el.remove(); 
				});
			});
		});
	}

	/**
	 * Removes all dynamic content (styles and DOM elements) from a specific Markdown view.
	 * @param view The MarkdownView to clean.
	 */
	private async removeDynamicContentFromView(view: MarkdownView): Promise<void> {
		this.removeLivePreviewFooterStyles(view); 
		await this.removeInjectedContentDOM(view.containerEl); 
	}

	/**
	 * Clears dynamic content from all currently open Markdown views.
	 * Typically used during plugin unload or when global settings change significantly.
	 */
	private clearAllViewsDynamicContent(): void {
		this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
			if (leaf.view instanceof MarkdownView) {
				this.removeDynamicContentFromView(leaf.view);
			}
		});
	}

	/**
	 * Determines all applicable rules and fetches their content for a given file path.
	 * Rules are processed in the order they are defined in the settings.
	 * @param filePath The path of the file to evaluate against the rules.
	 * @returns A promise that resolves to an array of objects, each containing a matched Rule and its content string.
	 */
	private async _getApplicableRulesAndContent(filePath: string): Promise<Array<{ rule: Rule; contentText: string }>> {
		const allApplicable: Array<{ rule: Rule; contentText: string }> = [];
		const abstractFile = this.app.vault.getAbstractFileByPath(filePath);
		
		if (!(abstractFile instanceof TFile)) {
			return [];
		}
		const file: TFile = abstractFile;

		let fileTags: string[] | null = null;
		const fileCache = this.app.metadataCache.getFileCache(file);
		if (fileCache) {
			const allTagsInFileWithHash = getAllTags(fileCache);
			fileTags = allTagsInFileWithHash ? allTagsInFileWithHash.map(tag => tag.substring(1)) : [];
		}

		for (const currentRule of this.settings.rules) {
			let isMatch = false;
			const ruleRecursive = currentRule.recursive === undefined ? true : currentRule.recursive;


			if (currentRule.type === RuleType.Folder && currentRule.path !== undefined) {
				if (currentRule.path === "") { 
					isMatch = true; 
				} else if (currentRule.path === "/") { 
					if (ruleRecursive) { 
						isMatch = true;
					} else { 
						if (file.parent && file.parent.isRoot()) {
							isMatch = true;
						}
					}
				} else { 
					let normalizedRuleFolderPath = currentRule.path;
					if (normalizedRuleFolderPath.endsWith('/')) {
						normalizedRuleFolderPath = normalizedRuleFolderPath.slice(0, -1);
					}
					
					if (ruleRecursive) {
						const prefixToMatch = normalizedRuleFolderPath + '/';
						if (file.path.startsWith(prefixToMatch)) {
							isMatch = true;
						}
					} else {
						if (file.parent && file.parent.path === normalizedRuleFolderPath) {
							isMatch = true;
						}
					}
				}
			} else if (currentRule.type === RuleType.Tag && currentRule.tag && fileTags) {
				const ruleTag = currentRule.tag;
				// includeSubtags is guaranteed to be boolean by normalizeRule
				const includeSubtags = currentRule.includeSubtags!; 

				for (const fileTag of fileTags) {
					if (includeSubtags) {
						if (fileTag === ruleTag || fileTag.startsWith(ruleTag + '/')) {
							isMatch = true;
							break;
						}
					} else {
						if (fileTag === ruleTag) {
							isMatch = true;
							break;
						}
					}
				}
			}

			if (isMatch) {
				const contentText = await this._fetchContentForRule(currentRule);
				allApplicable.push({ rule: currentRule, contentText });
			}
		}
		return allApplicable;
	}

	/**
	 * Fetches the content for a given rule, either from its direct text or from a specified file.
	 * @param rule The rule for which to fetch content.
	 * @returns A promise that resolves to the content string. Returns an empty string if content is not found or empty.
	 */
	private async _fetchContentForRule(rule: Rule): Promise<string> {
		if (rule.contentSource === ContentSource.File && rule.footerFilePath) {
			const file = this.app.vault.getAbstractFileByPath(rule.footerFilePath);
			if (file instanceof TFile) {
				try {
					return await this.app.vault.cachedRead(file);
				} catch (error) {
					console.error(`VirtualFooter: Error reading content file ${rule.footerFilePath}`, error);
					return ""; 
				}
			} else {
				console.warn(`VirtualFooter: Content file not found for rule: ${rule.footerFilePath}`);
				return ""; 
			}
		}
		return rule.footerText || ""; 
	}


	/**
	 * Attaches event handlers for internal links (e.g., `[[wikilinks]]`) within the dynamically injected content.
	 * Handles left-clicks, Ctrl/Meta + left-clicks (new pane), and middle-clicks (new pane).
	 * @param container The HTMLElement containing the rendered Markdown with internal links.
	 * @param sourcePath The path of the file where the content is injected, used for link resolution.
	 * @param component The Obsidian Component associated with this rendered content, to register DOM events for proper cleanup.
	 */
	private attachInternalLinkHandlers(container: HTMLElement, sourcePath: string, component: Component): void {
		component.registerDomEvent(container, 'click', (event: MouseEvent) => {
			if (event.button !== 0) return; 
			const target = event.target as HTMLElement;
			const linkElement = target.closest('a.internal-link') as HTMLAnchorElement;

			if (linkElement) {
				event.preventDefault(); 
				const href = linkElement.dataset.href; 
				if (href) {
					const inNewPane = event.ctrlKey || event.metaKey; 
					this.app.workspace.openLinkText(href, sourcePath, inNewPane);
				}
			}
		});

		component.registerDomEvent(container, 'auxclick', (event: MouseEvent) => {
			if (event.button !== 1) return; 
			const target = event.target as HTMLElement;
			const linkElement = target.closest('a.internal-link') as HTMLAnchorElement;

			if (linkElement) {
				event.preventDefault(); 
				const href = linkElement.dataset.href;
				if (href) {
					this.app.workspace.openLinkText(href, sourcePath, true); 
				}
			}
		});
	}

	/**
	 * Loads plugin settings from Obsidian's storage.
	 * Performs migration from older settings formats if necessary.
	 * Ensures that settings are initialized with defaults if no settings exist.
	 */
	async loadSettings() {
		const loadedData = await this.loadData();
		this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

		if (loadedData) {
			const oldGlobalRenderLocation = loadedData.renderLocation as RenderLocation | undefined;

			if (loadedData.rules && Array.isArray(loadedData.rules)) {
				this.settings.rules = loadedData.rules.map((loadedRule: any) =>
					this._migrateRule(loadedRule, oldGlobalRenderLocation)
				);
			}
		}

		if (!this.settings.rules || this.settings.rules.length === 0) {
			this.settings.rules = [JSON.parse(JSON.stringify(DEFAULT_SETTINGS.rules[0]))];
		} else {
			this.settings.rules.forEach(rule => this.normalizeRule(rule));
		}
	}

	/**
	 * Migrates a single rule object from a potentially older format to the current Rule interface.
	 * This handles changes in property names or structure over plugin versions.
	 * @param loadedRule The raw rule object loaded from storage.
	 * @param globalRenderLocation An optional global render location from older settings,
	 *                             used as a fallback if the rule itself doesn't specify one.
	 * @returns A Rule object, migrated to the current format.
	 */
	private _migrateRule(loadedRule: any, globalRenderLocation?: RenderLocation): Rule {
		let type: RuleType;
		if (loadedRule.type === RuleType.Folder || loadedRule.type === RuleType.Tag) {
			type = loadedRule.type;
		} else if (typeof loadedRule.folderPath === 'string') { 
			type = RuleType.Folder;
		} else {
			type = DEFAULT_SETTINGS.rules[0].type; 
		}

		let contentSource: ContentSource;
		if (loadedRule.contentSource === ContentSource.Text || loadedRule.contentSource === ContentSource.File) {
			contentSource = loadedRule.contentSource;
		} else {
			contentSource = (typeof loadedRule.folderPath === 'string' && loadedRule.contentSource === undefined)
				? ContentSource.Text
				: DEFAULT_SETTINGS.rules[0].contentSource; 
		}

		const migratedRule: Rule = {
			type: type,
			contentSource: contentSource,
			footerText: loadedRule.footerText || '', 
			renderLocation: loadedRule.renderLocation || globalRenderLocation || DEFAULT_SETTINGS.rules[0].renderLocation,
			recursive: loadedRule.recursive !== undefined ? loadedRule.recursive : true, 
		};

		if (migratedRule.type === RuleType.Folder) {
			migratedRule.path = loadedRule.path !== undefined ? loadedRule.path :
				(loadedRule.folderPath !== undefined ? loadedRule.folderPath : DEFAULT_SETTINGS.rules[0].path); 
		} else { // RuleType.Tag
			migratedRule.tag = loadedRule.tag !== undefined ? loadedRule.tag : '';
			migratedRule.includeSubtags = loadedRule.includeSubtags !== undefined ? loadedRule.includeSubtags : false; // Default to false for old tag rules
			delete migratedRule.recursive; 
		}

		if (migratedRule.contentSource === ContentSource.File) {
			migratedRule.footerFilePath = loadedRule.footerFilePath || '';
		}

		return migratedRule;
	}

	/**
	 * Normalizes a rule to ensure all necessary fields are present and correctly initialized.
	 * Also handles mutually exclusive fields (e.g., `path` vs `tag`).
	 * This is called after migration or when new rules are created/modified.
	 * @param rule The rule object to normalize.
	 */
	public normalizeRule(rule: Rule): void {
		rule.type = rule.type || DEFAULT_SETTINGS.rules[0].type;

		if (rule.type === RuleType.Folder) {
			rule.path = rule.path === undefined ? (DEFAULT_SETTINGS.rules[0].path || '') : rule.path;
			if (rule.path === "") {
				rule.recursive = true;
			} else {
				rule.recursive = typeof rule.recursive === 'boolean' ? rule.recursive : true;
			}
			delete rule.tag; 
			delete rule.includeSubtags;
		} else { // RuleType.Tag
			rule.tag = rule.tag === undefined ? '' : rule.tag;
			rule.includeSubtags = typeof rule.includeSubtags === 'boolean' ? rule.includeSubtags : false; // Default to false
			delete rule.path; 
			delete rule.recursive; 
		}

		rule.contentSource = rule.contentSource || DEFAULT_SETTINGS.rules[0].contentSource;
		rule.footerText = rule.footerText || '';
		rule.renderLocation = rule.renderLocation || DEFAULT_SETTINGS.rules[0].renderLocation;

		if (rule.contentSource === ContentSource.File) {
			rule.footerFilePath = rule.footerFilePath || '';
		} else {
			delete rule.footerFilePath; 
		}
	}

	/**
	 * Saves the current plugin settings to Obsidian's storage.
	 * Normalizes all rules before saving and triggers a refresh of the active view.
	 */
	async saveSettings() {
		this.settings.rules.forEach(rule => this.normalizeRule(rule));
		await this.saveData(this.settings);
		this.handleActiveViewChange();
	}
}

/**
 * Manages the settings tab for the VirtualFooter plugin.
 * Allows users to configure rules for dynamic content injection.
 */
class VirtualFooterSettingTab extends PluginSettingTab {
	private allFolderPathsCache: Set<string> | null = null;
	private allTagsCache: Set<string> | null = null;
	private allMarkdownFilePathsCache: Set<string> | null = null;

	constructor(app: App, private plugin: VirtualFooterPlugin) {
		super(app, plugin);
	}

	/**
	 * Generates a set of all unique folder paths in the vault.
	 * Includes "/" for the root folder and ensures paths end with "/".
	 * @returns A Set of available folder paths.
	 */
	private getAvailableFolderPaths(): Set<string> {
		if (this.allFolderPathsCache) return this.allFolderPathsCache;

		const paths = new Set<string>(['/', '']); // Added "" for "all files"
		this.app.vault.getAllLoadedFiles().forEach(file => {
			if (file.parent) { 
				const parentPath = file.parent.isRoot() ? '/' : (file.parent.path.endsWith('/') ? file.parent.path : file.parent.path + '/');
				if (parentPath !== '/') paths.add(parentPath); // Avoid adding '/' twice if root has files
			}
			if ('children' in file && file.path !== '/') { // It's a folder and not the root
				const folderPath = file.path.endsWith('/') ? file.path : file.path + '/';
				paths.add(folderPath);
			}
		});
		this.allFolderPathsCache = paths;
		return paths;
	}

	/**
	 * Generates a set of all unique tags (without the '#' prefix) present in the vault.
	 * @returns A Set of available tags.
	 */
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

	/**
	 * Generates a set of all Markdown file paths in the vault.
	 * Used for suggesting content files for rules.
	 * @returns A Set of available .md file paths.
	 */
	private getAvailableMarkdownFilePaths(): Set<string> {
		if (this.allMarkdownFilePathsCache) return this.allMarkdownFilePathsCache;

		const paths = new Set<string>();
		this.app.vault.getMarkdownFiles().forEach(file => {
			paths.add(file.path);
		});
		this.allMarkdownFilePathsCache = paths;
		return paths;
	}

	/**
	 * Renders the settings tab UI.
	 * Clears existing content and rebuilds the settings form.
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.allFolderPathsCache = null;
		this.allTagsCache = null;
		this.allMarkdownFilePathsCache = null;

		containerEl.createEl('h2', { text: 'Virtual Content Settings' });
		containerEl.createEl('p', { text: 'Define rules to dynamically add content to the header or footer of notes based on their folder or tags.' });


		containerEl.createEl('h3', { text: 'Rules' });
		const rulesContainer = containerEl.createDiv('rules-container virtual-footer-rules-container');

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
					const newRule = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.rules[0]));
					this.plugin.normalizeRule(newRule); // Ensure it's fully initialized
					this.plugin.settings.rules.push(newRule);
					await this.plugin.saveSettings();
					this.display(); 
				}));
	}

	/**
	 * Renders the UI controls for a single rule within the settings tab.
	 * @param rule The rule object to render controls for.
	 * @param index The index of the rule in the settings.rules array.
	 * @param containerEl The HTML element to append the rule controls to.
	 */
	private renderRuleControls(rule: Rule, index: number, containerEl: HTMLElement): void {
		const ruleDiv = containerEl.createDiv('rule-item virtual-footer-rule-item');
		ruleDiv.createEl('h4', { text: `Rule ${index + 1}` });

		new Setting(ruleDiv)
			.setName('Rule type')
			.setDesc('Apply this rule based on folder or tag.')
			.addDropdown(dropdown => dropdown
				.addOption(RuleType.Folder, 'Folder')
				.addOption(RuleType.Tag, 'Tag')
				.setValue(rule.type)
				.onChange(async (value: string) => {
					rule.type = value as RuleType;
					this.plugin.normalizeRule(rule); 
					await this.plugin.saveSettings();
					this.display(); 
				}));

		if (rule.type === RuleType.Folder) {
			new Setting(ruleDiv)
				.setName('Folder path')
				.setDesc('Path for the rule. Use "" for all files, "/" for root folder, or "FolderName/" for specific folders.')
				.addText(text => {
					text.setPlaceholder('e.g., Meetings/, /, or empty for all')
						.setValue(rule.path || '')
						.onChange(async (value) => {
							rule.path = value;
							this.plugin.normalizeRule(rule);
							await this.plugin.saveSettings();
							this.display(); 
						});
					new MultiSuggest(text.inputEl, this.getAvailableFolderPaths(), (selectedPath) => {
						rule.path = selectedPath;
						this.plugin.normalizeRule(rule);
						text.setValue(selectedPath); 
						this.plugin.saveSettings();
						this.display(); 
					}, this.plugin.app);
				});
			
			new Setting(ruleDiv)
				.setName('Include subfolders (recursive)')
				.setDesc('If enabled, rule applies to files in subfolders. For "all files" (empty path), this is always true. For root path ("/"), enabling applies to all vault files, disabling applies only to files directly in the root.')
				.addToggle(toggle => {
					toggle.setValue(rule.recursive!) 
						.onChange(async (value) => {
							rule.recursive = value;
							await this.plugin.saveSettings();
						});
					if (rule.path === "") {
						toggle.setDisabled(true);
					}
				});

		} else if (rule.type === RuleType.Tag) {
			new Setting(ruleDiv)
				.setName('Tag value')
				.setDesc('Tag to match (without the # prefix).')
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

			// Setting for includeSubtags (only for Tag type)
			new Setting(ruleDiv)
				.setName('Include subtags')
				.setDesc("If enabled, a rule for 'tag' will also apply to 'tag/subtag1', 'tag/subtag2/subtag3', etc. If disabled, it only applies to the exact tag.")
				.addToggle(toggle => {
					// rule.includeSubtags is guaranteed to be boolean by normalizeRule
					toggle.setValue(rule.includeSubtags!)
						.onChange(async (value) => {
							rule.includeSubtags = value;
							await this.plugin.saveSettings();
						});
				});
		}

		new Setting(ruleDiv)
			.setName('Content source')
			.setDesc('Where to get the content from.')
			.addDropdown(dropdown => dropdown
				.addOption(ContentSource.Text, 'Direct text')
				.addOption(ContentSource.File, 'Markdown file')
				.setValue(rule.contentSource || ContentSource.Text) 
				.onChange(async (value: string) => {
					rule.contentSource = value as ContentSource;
					this.plugin.normalizeRule(rule); 
					await this.plugin.saveSettings();
					this.display(); 
				}));

		if (rule.contentSource === ContentSource.File) {
			new Setting(ruleDiv)
				.setName('Content file path')
				.setDesc('Path to the .md file to use as content.')
				.addText(text => {
					text.setPlaceholder('e.g., templates/common-footer.md')
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
				.setDesc('Markdown text to display. This will be rendered.')
				.addTextArea(text => text
					.setPlaceholder('Enter your markdown content here...\nSupports multiple lines and **Markdown** formatting.')
					.setValue(rule.footerText || '')
					.onChange(async (value) => {
						rule.footerText = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(ruleDiv)
			.setName('Render location')
			.setDesc('Choose where this rule renders its content.')
			.addDropdown(dropdown => dropdown
				.addOption(RenderLocation.Footer, 'Footer')
				.addOption(RenderLocation.Header, 'Header')
				.setValue(rule.renderLocation || RenderLocation.Footer) 
				.onChange(async (value: string) => {
					rule.renderLocation = value as RenderLocation;
					await this.plugin.saveSettings();
				}));

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