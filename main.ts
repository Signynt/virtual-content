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
	ItemView,
	WorkspaceLeaf,
	debounce,
} from 'obsidian';

// --- Enums ---

/** Defines the type of a rule, determining how it matches files (e.g., by folder, tag, or property). */
enum RuleType {
	Folder = 'folder',
	Tag = 'tag',
	Property = 'property',
	Multi = 'multi',
	Dataview = 'dataview',
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
	Sidebar = 'sidebar',
}

// --- Interfaces ---

/**
 * Represents a single condition for a 'Multi' rule type.
 */
interface SubCondition {
	/** The type of condition (folder, tag, or property). */
	type: 'folder' | 'tag' | 'property';
	/** Whether this condition should be negated (not met). Defaults to false. */
	negated?: boolean;
	/** For 'folder' type: path to the folder. */
	path?: string;
	/** For 'folder' type: whether to match subfolders. */
	recursive?: boolean;
	/** For 'tag' type: the tag name (without '#'). */
	tag?: string;
	/** For 'tag' type: whether to match subtags. */
	includeSubtags?: boolean;
	/** For 'property' type: the name of the frontmatter property. */
	propertyName?: string;
	/** For 'property' type: the value the frontmatter property should have. */
	propertyValue?: string;
}

/**
 * Represents a rule for injecting dynamic content into Markdown views.
 * Each rule specifies matching criteria (type: folder/tag/property), content source (text/file),
 * the content itself, and where it should be rendered (header/footer).
 */
interface Rule {
	/** A descriptive name for this rule. */
	name?: string;
	/** Whether this rule is currently active. */
	enabled?: boolean;
	/** The type of criteria for this rule (folder-based, tag-based, or property-based). */
	type: RuleType;
	/** Whether this rule's condition should be negated (not met). Defaults to false. */
	negated?: boolean;
	/** For 'folder' type: path to the folder. "" for all files, "/" for root. */
	path?: string;
	/** For 'tag' type: the tag name (without '#'). */
	tag?: string;
	/** For 'folder' type: whether to match subfolders. Defaults to true. Ignored if path is "". */
	recursive?: boolean;
	/** For 'tag' type: whether to match subtags (e.g., 'tag' matches 'tag/subtag'). Defaults to false. */
	includeSubtags?: boolean;
	/** For 'property' type: the name of the frontmatter property. */
	propertyName?: string;
	/** For 'property' type: the value the frontmatter property should have. */
	propertyValue?: string;
	/** For 'multi' type: an array of sub-conditions. */
	conditions?: SubCondition[];
	/** For 'multi' type: specifies whether ANY or ALL conditions must be met. Defaults to 'any'. */
	multiConditionLogic?: 'any' | 'all';
	/** For 'dataview' type: the Dataview query to use for matching files. */
	dataviewQuery?: string;
	/** The source from which to get the content (direct text or a file). */
	contentSource: ContentSource;
	/** Direct text content if contentSource is 'text'. */
	footerText: string; // Retained name for compatibility, though it can be header or footer content.
	/** Path to a .md file if contentSource is 'file'. */
	footerFilePath?: string; // Retained name for compatibility.
	/** Specifies whether to render in the header or footer. */
	renderLocation: RenderLocation;
	/** For 'sidebar' location: whether to show in a separate tab. */
	showInSeparateTab?: boolean;
	/** For 'sidebar' location: the name of the separate tab. */
	sidebarTabName?: string;
	/** For 'header' location: whether to render above the properties section. */
	renderAboveProperties?: boolean;
	/** For 'footer' location: whether to render above the backlinks section. */
	renderAboveBacklinks?: boolean;
	/** Whether to show this rule's content in popover views. */
	showInPopover?: boolean;
}

/**
 * Defines the settings structure for the VirtualFooter plugin.
 * Contains an array of rules that dictate content injection.
 */
interface VirtualFooterSettings {
	rules: Rule[];
	/** Whether to refresh the view on file open. Defaults to false. */
	refreshOnFileOpen?: boolean;
	/** Whether to render content in source mode. Defaults to false. */
	renderInSourceMode?: boolean;
	/** Whether to refresh the view when note metadata changes. Defaults to false. */
	refreshOnMetadataChange?: boolean;
	/** Whether to treat property values as links for matching file targets. */
	smartPropertyLinks?: boolean;
}

/**
 * Extends HTMLElement to associate an Obsidian Component for lifecycle management.
 * This allows Obsidian to manage resources tied to the DOM element.
 */
interface HTMLElementWithComponent extends HTMLElement {
	/** The Obsidian Component associated with this HTML element. */
	component?: Component;
}

// --- Constants ---

/** Default settings for the plugin, used when no settings are found or for new rules. */
const DEFAULT_SETTINGS: VirtualFooterSettings = {
	rules: [{
		name: 'Default Rule',
		enabled: true,
		type: RuleType.Folder,
		path: '', // Matches all files by default
		recursive: true,
		contentSource: ContentSource.Text,
		footerText: '', // Default content is empty
		renderLocation: RenderLocation.Footer,
		showInSeparateTab: false,
		sidebarTabName: '',
		multiConditionLogic: 'any',
		renderAboveProperties: false,
		renderAboveBacklinks: false,
		showInPopover: true,
	}],
	refreshOnFileOpen: false, // Default to false
	renderInSourceMode: false, // Default to false
	refreshOnMetadataChange: false, // Default to false
	smartPropertyLinks: false, // Default to false
};

// CSS Classes for styling and identifying plugin-generated elements
const CSS_DYNAMIC_CONTENT_ELEMENT = 'virtual-footer-dynamic-content-element';
const CSS_HEADER_GROUP_ELEMENT = 'virtual-footer-header-group';
const CSS_FOOTER_GROUP_ELEMENT = 'virtual-footer-footer-group';
const CSS_HEADER_RENDERED_CONTENT = 'virtual-footer-header-rendered-content';
const CSS_FOOTER_RENDERED_CONTENT = 'virtual-footer-footer-rendered-content';
const CSS_VIRTUAL_FOOTER_CM_PADDING = 'virtual-footer-cm-padding'; // For CodeMirror live preview footer spacing
const CSS_VIRTUAL_FOOTER_REMOVE_FLEX = 'virtual-footer-remove-flex'; // For CodeMirror live preview footer layout
const CSS_ABOVE_BACKLINKS = 'virtual-footer-above-backlinks'; // For removing min-height when above backlinks

// DOM Selectors for targeting elements in Obsidian's interface
const SELECTOR_EDITOR_CONTENT_AREA = '.cm-editor .cm-content';
const SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT = '.markdown-source-view.mod-cm6 .cm-contentContainer';
const SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER = '.cm-contentContainer';
const SELECTOR_EDITOR_SIZER = '.cm-sizer'; // Target for live preview footer injection
const SELECTOR_PREVIEW_HEADER_AREA = '.mod-header.mod-ui'; // Target for reading mode header injection
const SELECTOR_PREVIEW_FOOTER_AREA = '.mod-footer'; // Target for reading mode footer injection
const SELECTOR_EMBEDDED_BACKLINKS = '.embedded-backlinks'; // Target for positioning above backlinks
const SELECTOR_METADATA_CONTAINER = '.metadata-container'; // Target for positioning above properties

const VIRTUAL_CONTENT_VIEW_TYPE = 'virtual-content-view';
const VIRTUAL_CONTENT_SEPARATE_VIEW_TYPE_PREFIX = 'virtual-content-separate-view-';

// --- Utility Classes ---

/**
 * A suggestion provider for input fields, offering autocompletion from a given set of strings.
 */
export class MultiSuggest extends AbstractInputSuggest<string> {
	/**
	 * Creates an instance of MultiSuggest.
	 * @param inputEl The HTML input element to attach the suggester to.
	 * @param content The set of strings to use as suggestions.
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
	 * @param content The selected suggestion string.
	 * @param _evt The mouse or keyboard event that triggered the selection.
	 */
	selectSuggestion(content: string, _evt: MouseEvent | KeyboardEvent): void {
		this.onSelectCb(content);
		this.inputEl.value = content; // Update input field with selected value
		this.inputEl.blur(); // Remove focus from input
		this.close(); // Close the suggestion popover
	}
}

// --- Sidebar View Class ---

export class VirtualContentView extends ItemView {
	plugin: VirtualFooterPlugin;
	viewContent: HTMLElement;
	component: Component;
	private contentProvider: () => { content: string, sourcePath: string } | null;
	private viewId: string;
	private tabName: string;

	constructor(leaf: WorkspaceLeaf, plugin: VirtualFooterPlugin, viewId: string, tabName: string, contentProvider: () => { content: string, sourcePath: string } | null) {
		super(leaf);
		this.plugin = plugin;
		this.viewId = viewId;
		this.tabName = tabName;
		this.contentProvider = contentProvider;
	}

	getViewType() {
		return this.viewId;
	}

	getDisplayText() {
		return this.tabName;
	}

	getIcon() {
		return 'text-select';
	}

	protected async onOpen(): Promise<void> {
		this.component = new Component();
		this.component.load();

		const container = this.containerEl.children[1];
		container.empty();
		this.viewContent = container.createDiv({ cls: 'virtual-content-sidebar-view' });
		this.update();
	}



	protected async onClose(): Promise<void> {
		this.component.unload();
	}

	update() {
		if (!this.viewContent) return;

		// Clean up previous content and component
		this.viewContent.empty();
		this.component.unload();
		this.component = new Component();
		this.component.load();

		const data = this.contentProvider();
		if (data && data.content && data.content.trim() !== '') {
			MarkdownRenderer.render(this.app, data.content, this.viewContent, data.sourcePath, this.component);
			this.plugin.attachInternalLinkHandlers(this.viewContent, data.sourcePath, this.component);
		} else {
			this.viewContent.createEl('p', {
				text: 'No virtual content to display for the current note.',
				cls: 'virtual-content-sidebar-empty'
			});
		}
	}
}

// --- Main Plugin Class ---

/**
 * VirtualFooterPlugin dynamically injects content into the header or footer of Markdown views
 * based on configurable rules.
 */
export default class VirtualFooterPlugin extends Plugin {
	settings: VirtualFooterSettings;
	/** Stores pending content injections for preview mode, awaiting DOM availability. */
	private pendingPreviewInjections: WeakMap<MarkdownView, { 
		headerDiv?: HTMLElementWithComponent, 
		footerDiv?: HTMLElementWithComponent,
		headerAbovePropertiesDiv?: HTMLElementWithComponent,
		footerAboveBacklinksDiv?: HTMLElementWithComponent,
		filePath?: string
	}> = new WeakMap();
	/** Manages MutationObservers for views in preview mode to detect when injection targets are ready. */
	private previewObservers: WeakMap<MarkdownView, MutationObserver> = new WeakMap();
	private initialLayoutReadyProcessed = false;
	private lastSidebarContent: { content: string, sourcePath: string } | null = null;
	private lastSeparateTabContents: Map<string, { content: string, sourcePath: string }> = new Map();
	private lastHoveredLink: HTMLElement | null = null;

	/**
	 * Called when the plugin is loaded.
	 */
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new VirtualFooterSettingTab(this.app, this));

		this.registerView(
			VIRTUAL_CONTENT_VIEW_TYPE,
			(leaf) => new VirtualContentView(leaf, this, VIRTUAL_CONTENT_VIEW_TYPE, 'Virtual Content', () => this.getLastSidebarContent())
		);

		this.registerDynamicViews();

		this.addRibbonIcon('text-select', 'Open virtual content in sidebar', () => {
			this.activateView(VIRTUAL_CONTENT_VIEW_TYPE);
		});

		this.addCommand({
			id: 'open-virtual-content-sidebar',
			name: 'Open virtual content in sidebar',
			callback: () => {
				this.activateView(VIRTUAL_CONTENT_VIEW_TYPE);
			},
		});

		this.addCommand({
			id: 'open-all-virtual-content-sidebar-tabs',
			name: 'Open all virtual footer sidebar tabs',
			callback: () => {
				this.activateAllSidebarViews();
			},
		});

		// Define event handlers
		const handleViewUpdate = () => {
			// Always trigger an update if the layout is ready.
			// Used for file-open and layout-change.
			if (this.initialLayoutReadyProcessed) {
				this.handleActiveViewChange();
			}
		};

		const handleFocusChange = () => {
			// This is the "focus change" or "switching files" part, conditional on the setting.
			// Used for active-leaf-change.
			if (this.settings.refreshOnFileOpen && this.initialLayoutReadyProcessed) {
				this.handleActiveViewChange();
			}
		};

		// Register event listeners
		this.registerEvent(
			this.app.workspace.on('file-open', handleViewUpdate)
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', handleViewUpdate)
		);
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', handleFocusChange)
		);

		// Listen for metadata changes on the current file
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				// Only refresh if the metadata change setting is enabled
				if (this.settings.refreshOnMetadataChange && this.initialLayoutReadyProcessed) {
					const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
					// Only refresh if the changed file is the currently active one
					if (activeView && activeView.file && file.path === activeView.file.path) {
						this.handleActiveViewChange();
					}
				}
			})
		);

		// Listen for hover events to detect when popovers are created
		this.registerDomEvent(document, 'mouseover', (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			// Check if the target is a link that could trigger a popover
			if (target.matches('a.internal-link, .internal-link a, [data-href]')) {
				// Store the last hovered link for popover file path extraction
				this.lastHoveredLink = target;
				// Delay to allow popover to be created
				setTimeout(() => {this.processPopoverViews();}, 100);
			}
		});

		// Listen for clicks to detect when popovers might switch to editing mode
		this.registerDomEvent(document, 'click', (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			// Check if the click is within a popover
			const popover = target.closest('.popover.hover-popover');
			if (popover) {
				//console.log("VirtualContent: Click detected in popover, checking for mode change");
				// Delay to allow any mode changes to complete
				setTimeout(() => {this.processPopoverViews();}, 150);
			}
		});

		// Also listen for DOM mutations to catch dynamically created popovers
		const popoverObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (mutation.type === 'childList') {
					mutation.addedNodes.forEach(node => {
						if (node instanceof HTMLElement) {
							// Check if a popover was added
							if (node.classList.contains('popover') && node.classList.contains('hover-popover')) {
								//console.log("VirtualContent: Popover created, processing views");
								// Small delay to ensure the popover content is fully loaded
								setTimeout(() => {this.processPopoverViews();}, 50);
							}
							// Also check for popovers added within other elements
							const popovers = node.querySelectorAll('.popover.hover-popover');
							if (popovers.length > 0) {
								//console.log("VirtualContent: Popover(s) found in added content, processing views");
								setTimeout(() => {this.processPopoverViews();}, 50);
							}
						}
					});
				}
				// Listen for attribute changes that might indicate mode switching in popovers
				if (mutation.type === 'attributes' && mutation.target instanceof HTMLElement) {
					const target = mutation.target;
					// Check if this is a popover that gained or lost the is-editing class
					if (target.classList.contains('popover') && target.classList.contains('hover-popover')) {
						if (mutation.attributeName === 'class') {
							const hasEditingClass = target.classList.contains('is-editing');
							//console.log(`VirtualContent: Popover mode changed, is-editing: ${hasEditingClass}`);
							//setTimeout(() => {this.processPopoverViews();}, 100); // Slightly longer delay for mode changes
						}
					}
				}
			}
		});

		// Observe the entire document for popover creation
		popoverObserver.observe(document.body, {
			childList: true,
			subtree: true
		});

		// Store the observer so we can disconnect it on unload
		this.registerEvent({ 
			// @ts-ignore - Store observer reference for cleanup
			_observer: popoverObserver,
			// @ts-ignore - Custom cleanup method
			destroy: () => popoverObserver.disconnect()
		} as any);

		// Initial processing for any currently active view, once layout is ready
		this.app.workspace.onLayoutReady(() => {
			if (!this.initialLayoutReadyProcessed) {
				this.handleActiveViewChange(); // Process the initially open view
				this.initialLayoutReadyProcessed = true;
			}
		});
	}

	/**
	 * Called when the plugin is unloaded.
	 * Cleans up all injected content and observers.
	 */
	async onunload() {
		this.app.workspace.detachLeavesOfType(VIRTUAL_CONTENT_VIEW_TYPE);
		this.settings.rules.forEach((rule, index) => {
			if (rule.renderLocation === RenderLocation.Sidebar && rule.showInSeparateTab) {
				this.app.workspace.detachLeavesOfType(this.getSeparateViewId(index));
			}
		});
		this.clearAllViewsDynamicContent();

		// Clean up any remaining DOM elements and components directly
		document.querySelectorAll(`.${CSS_DYNAMIC_CONTENT_ELEMENT}`).forEach(el => {
			const componentHolder = el as HTMLElementWithComponent;
			if (componentHolder.component) {
				componentHolder.component.unload();
			}
			el.remove();
		});

		// Remove custom CSS classes applied for styling
		document.querySelectorAll(`.${CSS_VIRTUAL_FOOTER_CM_PADDING}`).forEach(el => el.classList.remove(CSS_VIRTUAL_FOOTER_CM_PADDING));
		document.querySelectorAll(`.${CSS_VIRTUAL_FOOTER_REMOVE_FLEX}`).forEach(el => el.classList.remove(CSS_VIRTUAL_FOOTER_REMOVE_FLEX));

		// WeakMaps will be garbage collected, but explicit clearing is good practice if needed.
		// Observers and pending injections are cleared per-view in `removeDynamicContentFromView`.
		this.previewObservers = new WeakMap();
		this.pendingPreviewInjections = new WeakMap();
	}

	/**
	 * Handles changes to the active Markdown view, triggering content processing.
	 */
	private handleActiveViewChange = () => {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		this._processView(activeView);
	}

	/**
	 * Checks if a MarkdownView is displayed within a popover (hover preview).
	 * @param view The MarkdownView to check.
	 * @returns True if the view is in a popover, false otherwise.
	 */
	private isInPopover(view: MarkdownView): boolean {
		// Check if the view's container element is within a popover
		let element: HTMLElement | null = view.containerEl;
		
		// Debug: Log the container element and its classes
		//console.log("VirtualContent: Checking popover for view container:", view.containerEl.className);
		
		while (element) {
			// Check for popover classes
			if (element.classList.contains('popover') && element.classList.contains('hover-popover')) {
				//console.log("VirtualContent: Found popover via direct popover classes");
				return true;
			}
			// Also check for markdown-embed class which indicates an embedded view (often in popovers)
			if (element.classList.contains('markdown-embed')) {
				//console.log("VirtualContent: Found markdown-embed, checking for parent popover");
				// If it's a markdown-embed, check if it's inside a popover
				let parent = element.parentElement;
				while (parent) {
					if (parent.classList.contains('popover') && parent.classList.contains('hover-popover')) {
						console.log("VirtualContent: Found popover via markdown-embed parent");
						return true;
					}
					parent = parent.parentElement;
				}
			}
			element = element.parentElement;
		}
		//console.log("VirtualContent: Not a popover view");
		return false;
	}

	/**
	 * Processes any popover views that might be open but haven't been processed yet.
	 */
	private processPopoverViews(): void {
		// Find all popover elements in the DOM
		const popovers = document.querySelectorAll('.popover.hover-popover');
		
		popovers.forEach(popover => {
			// Look for markdown views within each popover
			const markdownEmbed = popover.querySelector('.markdown-embed');
			if (markdownEmbed) {
				//console.log("VirtualContent: Found markdown-embed in popover, processing directly");
				// Process the popover content directly
				this.processPopoverDirectly(popover as HTMLElement);
			}
		});
	}

	/**
	 * Process popover content directly when we can't find the MarkdownView
	 */
	private processPopoverDirectly(popover: HTMLElement): void {
		console.log("VirtualContent: Processing popover directly");
		
		// Try to extract the file path from the popover
		const markdownEmbed = popover.querySelector('.markdown-embed');
		if (!markdownEmbed) {
			//console.log("VirtualContent: No markdown-embed found in popover");
			return;
		}
		
		let filePath: string | null = null;
		
		// Method 1: Get the title from inline-title and resolve to file path
		const inlineTitle = popover.querySelector('.inline-title');
		if (inlineTitle) {
			const title = inlineTitle.textContent?.trim();
			//console.log("VirtualContent: Found inline-title:", title);
			
			if (title) {
				// Try to resolve the title to a file path using Obsidian's API
				const file = this.app.metadataCache.getFirstLinkpathDest(title, '');
				if (file) {
					filePath = file.path;
					//console.log("VirtualContent: Resolved title to file path:", filePath);
				} else {
					// If direct resolution fails, try with .md extension
					const fileWithExt = this.app.metadataCache.getFirstLinkpathDest(title + '.md', '');
					if (fileWithExt) {
						filePath = fileWithExt.path;
						//console.log("VirtualContent: Resolved title with .md extension to file path:", filePath);
					} else {
						//console.log("VirtualContent: Could not resolve title to file path");
					}
				}
			}
		}
			
		//console.log("VirtualContent: Final extracted file path for direct processing:", filePath);
		
		if (filePath) {
			// Remove any hash fragments or block references
			const cleanPath = filePath.split('#')[0].split('^')[0];
			//console.log("VirtualContent: Cleaned file path:", cleanPath);
			// Process the popover content directly
			this.injectContentIntoPopover(popover, cleanPath);
		} else {
			console.log("VirtualContent: Could not determine file path for popover");
			// Log the DOM structure for debugging
			console.log("VirtualContent: Popover DOM structure:", popover.innerHTML.substring(0, 1000));
		}
	}

	/**
	 * Directly inject virtual content into a popover
	 */
	private async injectContentIntoPopover(popover: HTMLElement, filePath: string): Promise<void> {
		//console.log("VirtualContent: Directly injecting content into popover for:", filePath);
		
		try {
			const applicableRulesWithContent = await this._getApplicableRulesAndContent(filePath);
			
			// Filter rules based on popover visibility setting
			const filteredRules = applicableRulesWithContent.filter(({ rule }) => {
				return rule.showInPopover !== false; // Show by default unless explicitly disabled
			});
			
			if (filteredRules.length === 0) {
				//console.log("VirtualContent: No applicable rules for popover");
				return;
			}
			
			// Find the markdown embed container
			const markdownEmbed = popover.querySelector('.markdown-embed');
			if (!markdownEmbed) return;
			
			// Group content by render location
			const headerContentGroups: { normal: string[], aboveProperties: string[] } = { normal: [], aboveProperties: [] };
			const footerContentGroups: { normal: string[], aboveBacklinks: string[] } = { normal: [], aboveBacklinks: [] };
			const contentSeparator = "\n\n";
			
			for (const { rule, contentText } of filteredRules) {
				if (!contentText || contentText.trim() === "") continue;
				
				if (rule.renderLocation === RenderLocation.Header) {
					if (rule.renderAboveProperties) {
						headerContentGroups.aboveProperties.push(contentText);
					} else {
						headerContentGroups.normal.push(contentText);
					}
				} else if (rule.renderLocation === RenderLocation.Footer) {
					// For popovers, treat all footer content the same regardless of renderAboveBacklinks setting
					// since backlinks don't exist in popovers
					footerContentGroups.normal.push(contentText);
				}
				// Skip sidebar rules for popovers
			}
			
			// Inject header content
			if (headerContentGroups.normal.length > 0) {
				const combinedContent = headerContentGroups.normal.join(contentSeparator);
				await this.injectContentIntoPopoverSection(markdownEmbed as HTMLElement, combinedContent, 'header', false, filePath);
			}
			
			if (headerContentGroups.aboveProperties.length > 0) {
				const combinedContent = headerContentGroups.aboveProperties.join(contentSeparator);
				await this.injectContentIntoPopoverSection(markdownEmbed as HTMLElement, combinedContent, 'header', true, filePath);
			}
			
			// Inject footer content
			if (footerContentGroups.normal.length > 0) {
				const combinedContent = footerContentGroups.normal.join(contentSeparator);
				await this.injectContentIntoPopoverSection(markdownEmbed as HTMLElement, combinedContent, 'footer', false, filePath);
			}
			
		} catch (error) {
			console.error("VirtualContent: Error processing popover directly:", error);
		}
	}

	/**
	 * Inject content into a specific section of a popover
	 */
	private async injectContentIntoPopoverSection(
		container: HTMLElement, 
		content: string, 
		location: 'header' | 'footer', 
		special: boolean, 
		filePath: string
	): Promise<void> {
		const isHeader = location === 'header';
		const cssClass = isHeader ? CSS_HEADER_GROUP_ELEMENT : CSS_FOOTER_GROUP_ELEMENT;
		const specialClass = isHeader ? 'virtual-footer-above-properties' : 'virtual-footer-above-backlinks';
		
		// Create new content container
		const groupDiv = document.createElement('div') as HTMLElementWithComponent;
		groupDiv.className = `${CSS_DYNAMIC_CONTENT_ELEMENT} ${cssClass}`;
		if (special) {
			groupDiv.classList.add(specialClass);
		}
		
		// Add additional CSS classes for consistency with main view injection
		if (isHeader) {
			groupDiv.classList.add(CSS_HEADER_RENDERED_CONTENT);
		} else {
			groupDiv.classList.add(CSS_FOOTER_RENDERED_CONTENT);
			if (special) {
				groupDiv.classList.add(CSS_ABOVE_BACKLINKS);
			}
		}
		
		// Create component for lifecycle management
		const component = new Component();
		component.load();
		groupDiv.component = component;
		
		try {
			// Render the content
			await MarkdownRenderer.render(this.app, content, groupDiv, filePath, component);
			this.attachInternalLinkHandlers(groupDiv, filePath, component);
			
			// Use the same logic as main view injection - find target parent using standard selectors
			let targetParent: HTMLElement | null = null;
			
			// First, detect if we're in editing mode or preview mode
			// Check if the popover container has the is-editing class
			const popoverContainer = container.closest('.popover.hover-popover');
			const isEditingMode = popoverContainer?.classList.contains('is-editing') || 
								  container.querySelector(SELECTOR_EDITOR_SIZER) !== null;
			//console.log(`VirtualContent: Popover is in ${isEditingMode ? 'editing' : 'preview'} mode`);
			
			if (isHeader) {
				if (special) {
					// Try to find metadata container first (same as main view logic)
					targetParent = container.querySelector<HTMLElement>(SELECTOR_METADATA_CONTAINER);
				}
				// If no metadata container or special is false, use appropriate header area
				if (!targetParent) {
					if (isEditingMode) {
						// In editing mode, we need to find the content container and insert before it
						const cmContentContainer = container.querySelector<HTMLElement>(SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER);
						if (cmContentContainer?.parentElement) {
							// We'll handle the insertion differently for editing mode headers
							targetParent = cmContentContainer.parentElement;
						}
					} else {
						// In preview mode, use regular header area
						targetParent = container.querySelector<HTMLElement>(SELECTOR_PREVIEW_HEADER_AREA);
					}
				}
			} else { // Footer
				if (special) {
					// Try to find embedded backlinks first (same as main view logic)
					targetParent = container.querySelector<HTMLElement>(SELECTOR_EMBEDDED_BACKLINKS);
				}
				// If no backlinks or special is false, use appropriate footer area
				if (!targetParent) {
					if (isEditingMode) {
						// In editing mode, use editor sizer
						targetParent = container.querySelector<HTMLElement>(SELECTOR_EDITOR_SIZER);
					} else {
						// In preview mode, try standard footer area first
						targetParent = container.querySelector<HTMLElement>(SELECTOR_PREVIEW_FOOTER_AREA);
						// Fallback for popovers: use markdown-preview-sizer if standard footer selectors don't exist
						if (!targetParent) {
							targetParent = container.querySelector<HTMLElement>('.markdown-preview-sizer.markdown-preview-section');
						}
					}
				}
			}
			
			if (targetParent) {
				// Remove existing content of this type (same cleanup logic as main view)
				if (isHeader && special) {
					// Remove existing header content above properties
					container.querySelectorAll(`.${CSS_HEADER_GROUP_ELEMENT}.virtual-footer-above-properties`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
				} else if (isHeader && !special) {
					// Remove existing normal header content
					targetParent.querySelectorAll(`.${CSS_HEADER_GROUP_ELEMENT}:not(.virtual-footer-above-properties)`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
				} else if (!isHeader && special) {
					// Remove existing footer content above backlinks
					container.querySelectorAll(`.${CSS_FOOTER_GROUP_ELEMENT}.virtual-footer-above-backlinks`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
				} else if (!isHeader && !special) {
					// Remove existing normal footer content
					targetParent.querySelectorAll(`.${CSS_FOOTER_GROUP_ELEMENT}:not(.virtual-footer-above-backlinks)`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
				}
				
				// Insert using mode-specific logic
				if (isHeader && !special) {
					if (isEditingMode && targetParent.querySelector(SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER)) {
						// For editing mode headers, insert before the content container
						const cmContentContainer = targetParent.querySelector<HTMLElement>(SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER);
						if (cmContentContainer) {
							targetParent.insertBefore(groupDiv, cmContentContainer);
						} else {
							targetParent.appendChild(groupDiv);
						}
					} else {
						// For preview mode headers, append to header area
						targetParent.appendChild(groupDiv);
					}
				} else if (!isHeader && !special) {
					// For footer content
					if (isEditingMode) {
						// In editing mode, append to editor sizer
						targetParent.appendChild(groupDiv);
					} else {
						// In preview mode, check if we're using the popover fallback selector
						if (targetParent.matches('.markdown-preview-sizer.markdown-preview-section')) {
							// Insert after the markdown-preview-sizer, not inside it
							targetParent.parentElement?.insertBefore(groupDiv, targetParent.nextSibling);
						} else {
							// For regular footer areas, append inside
							targetParent.appendChild(groupDiv);
						}
					}
				} else {
					// Insert before properties or backlinks (same as main view)
					targetParent.parentElement?.insertBefore(groupDiv, targetParent);
				}
				
				//console.log(`VirtualContent: Successfully injected ${location} content into popover using standard selectors`);
			} else {
				//console.log(`VirtualContent: Target parent not found for ${location} injection in popover, falling back to container`);
				// Fallback to simple container injection if selectors don't match
				if (isHeader) {
					container.insertBefore(groupDiv, container.firstChild);
				} else {
					container.appendChild(groupDiv);
				}
			}
			
		} catch (error) {
			console.error("VirtualContent: Error rendering content for popover:", error);
			component.unload();
		}
	}

	/**
	 * Processes a given Markdown view to inject or update dynamic content.
	 * @param view The MarkdownView to process.
	 */
	private async _processView(view: MarkdownView | null): Promise<void> {
		if (!view || !view.file) {
			// If 'refresh on focus' is off, we clear the sidebar when focus is lost from a markdown file.
			// If it's on, we only clear the sidebar if the last markdown file has been closed,
			// preserving the content when switching to non-markdown views.
			if (!this.settings.refreshOnFileOpen || this.app.workspace.getLeavesOfType('markdown').length === 0) {
				this.lastSidebarContent = null;
				this.lastSeparateTabContents.clear();
				this.updateAllSidebarViews();
			}
			return; // No view or file to process
		}

		// Check if this is a popover view
		const isPopoverView = this.isInPopover(view);

		await this.removeDynamicContentFromView(view); // Clear existing content first
		const applicableRulesWithContent = await this._getApplicableRulesAndContent(view.file.path);

		// Filter rules based on popover visibility setting
		const filteredRules = applicableRulesWithContent.filter(({ rule }) => {
			if (isPopoverView && rule.showInPopover === false) {
				return false; // Skip this rule in popover views
			}
			return true;
		});

		const viewState = view.getState();
		let combinedHeaderText = "";
		let combinedFooterText = "";
		let combinedSidebarText = "";
		let hasFooterRule = false;
		const contentSeparator = "\n\n"; // Separator between content from multiple rules
		this.lastSeparateTabContents.clear();

		// Combine content from all applicable rules, grouping by render location and positioning
		const headerContentGroups: { normal: string[], aboveProperties: string[] } = { normal: [], aboveProperties: [] };
		const footerContentGroups: { normal: string[], aboveBacklinks: string[] } = { normal: [], aboveBacklinks: [] };
		
		for (const { rule, contentText, index } of filteredRules) {
			if (!contentText || contentText.trim() === "") continue; // Skip empty content

			if (rule.renderLocation === RenderLocation.Header) {
				if (rule.renderAboveProperties) {
					headerContentGroups.aboveProperties.push(contentText);
				} else {
					headerContentGroups.normal.push(contentText);
				}
			} else if (rule.renderLocation === RenderLocation.Footer) {
				if (rule.renderAboveBacklinks) {
					footerContentGroups.aboveBacklinks.push(contentText);
				} else {
					footerContentGroups.normal.push(contentText);
				}
				hasFooterRule = true;
			} else if (rule.renderLocation === RenderLocation.Sidebar) {
				if (rule.showInSeparateTab) {
					const viewId = this.getSeparateViewId(index);
					const existingContent = this.lastSeparateTabContents.get(viewId)?.content || "";
					this.lastSeparateTabContents.set(viewId, {
						content: (existingContent ? existingContent + contentSeparator : "") + contentText,
						sourcePath: view.file.path
					});
				} else {
					combinedSidebarText += (combinedSidebarText ? contentSeparator : "") + contentText;
				}
			}
		}

		// Store sidebar content and update the view
		this.lastSidebarContent = { content: combinedSidebarText, sourcePath: view.file.path };
		this.updateAllSidebarViews();

		// Determine if we should render based on view mode and settings
		const isLivePreview = viewState.mode === 'source' && !viewState.source;
		const isSourceMode = viewState.mode === 'source' && viewState.source;
		const isReadingMode = viewState.mode === 'preview';

		const shouldRenderInSource = isSourceMode && this.settings.renderInSourceMode;
		const shouldRenderInLivePreview = isLivePreview;
		const shouldRenderInReading = isReadingMode;

		// Apply specific styles for Live Preview footers if needed
		if ((shouldRenderInLivePreview || shouldRenderInSource) && hasFooterRule) {
			this.applyLivePreviewFooterStyles(view);
		}

		let pendingHeaderDiv: HTMLElementWithComponent | null = null;
		let pendingFooterDiv: HTMLElementWithComponent | null = null;
		let pendingHeaderAbovePropertiesDiv: HTMLElementWithComponent | null = null;
		let pendingFooterAboveBacklinksDiv: HTMLElementWithComponent | null = null;

		// Render and inject content based on view mode, handling each positioning group separately
		if (shouldRenderInReading || shouldRenderInLivePreview || shouldRenderInSource) {
			// Handle normal header content
			if (headerContentGroups.normal.length > 0) {
				const combinedContent = headerContentGroups.normal.join(contentSeparator);
				const result = await this.renderAndInjectGroupedContent(view, combinedContent, RenderLocation.Header, false);
				if (result && shouldRenderInReading) {
					pendingHeaderDiv = result;
				}
			}
			
			// Handle header content above properties
			if (headerContentGroups.aboveProperties.length > 0) {
				const combinedContent = headerContentGroups.aboveProperties.join(contentSeparator);
				const result = await this.renderAndInjectGroupedContent(view, combinedContent, RenderLocation.Header, true);
				if (result && shouldRenderInReading) {
					pendingHeaderAbovePropertiesDiv = result;
				}
			}
			
			// Handle normal footer content
			if (footerContentGroups.normal.length > 0) {
				const combinedContent = footerContentGroups.normal.join(contentSeparator);
				const result = await this.renderAndInjectGroupedContent(view, combinedContent, RenderLocation.Footer, false, false);
				if (result && shouldRenderInReading) {
					pendingFooterDiv = result;
				}
			}
			
			// Handle footer content above backlinks
			if (footerContentGroups.aboveBacklinks.length > 0) {
				const combinedContent = footerContentGroups.aboveBacklinks.join(contentSeparator);
				const result = await this.renderAndInjectGroupedContent(view, combinedContent, RenderLocation.Footer, false, true);
				if (result && shouldRenderInReading) {
					pendingFooterAboveBacklinksDiv = result;
				}
			}
		}

		// If any content is pending for preview mode, set up an observer
		if (pendingHeaderDiv || pendingFooterDiv || pendingHeaderAbovePropertiesDiv || pendingFooterAboveBacklinksDiv) {
			this.pendingPreviewInjections.set(view, {
				headerDiv: pendingHeaderDiv || undefined,
				footerDiv: pendingFooterDiv || undefined,
				headerAbovePropertiesDiv: pendingHeaderAbovePropertiesDiv || undefined,
				footerAboveBacklinksDiv: pendingFooterAboveBacklinksDiv || undefined,
				filePath: view.file.path,
			});
			this.ensurePreviewObserver(view);
		}
	}

	/**
	 * Renders combined Markdown content and injects it into the specified location in the view.
	 * @param view The MarkdownView to inject content into.
	 * @param combinedContentText The combined Markdown string to render.
	 * @param renderLocation Specifies whether to render in the header or footer.
	 * @param renderAboveProperties For header content, whether to render above properties section.
	 * @param renderAboveBacklinks For footer content, whether to render above backlinks section.
	 * @returns The rendered HTMLElement if injection is deferred (for preview mode), otherwise null.
	 */
	private async renderAndInjectGroupedContent(
		view: MarkdownView,
		combinedContentText: string,
		renderLocation: RenderLocation,
		renderAboveProperties: boolean = false,
		renderAboveBacklinks: boolean = false
	): Promise<HTMLElementWithComponent | null> {
		if (!combinedContentText || combinedContentText.trim() === "") {
			return null;
		}

		const isRenderInHeader = renderLocation === RenderLocation.Header;
		const sourcePath = view.file?.path || ''; // For MarkdownRenderer context

		// Create container div for the content
		const groupDiv = document.createElement('div') as HTMLElementWithComponent;
		groupDiv.className = CSS_DYNAMIC_CONTENT_ELEMENT; // Base class for all injected content
		groupDiv.classList.add(
			isRenderInHeader ? CSS_HEADER_GROUP_ELEMENT : CSS_FOOTER_GROUP_ELEMENT,
			isRenderInHeader ? CSS_HEADER_RENDERED_CONTENT : CSS_FOOTER_RENDERED_CONTENT
		);

		// Add the above-backlinks class for footer content when the setting is enabled
		if (!isRenderInHeader && renderAboveBacklinks) {
			groupDiv.classList.add(CSS_ABOVE_BACKLINKS);
			groupDiv.classList.add('virtual-footer-above-backlinks');
		}
		
		// Add the above-properties class for header content when the setting is enabled
		if (isRenderInHeader && renderAboveProperties) {
			groupDiv.classList.add('virtual-footer-above-properties');
		}

		// Create and manage an Obsidian Component for the lifecycle of this content
		const component = new Component();
		component.load();
		groupDiv.component = component;

		// Try to render the Markdown content with retry logic for early load errors
		try {
			await MarkdownRenderer.render(this.app, combinedContentText, groupDiv, sourcePath, component);
		} catch (error) {
			console.log("VirtualFooter: Error during initial render, will retry after delay:", error);
			
			// Add a placeholder while waiting to retry
			const placeholderEl = groupDiv.createEl("div", { cls: "virtual-footer-loading" });
			placeholderEl.createEl("p", { text: "Loading virtual content..." });
			
			// Schedule a retry after a delay to allow other plugins to initialize
			setTimeout(async () => {
				try {
					placeholderEl.remove();
					await MarkdownRenderer.render(this.app, combinedContentText, groupDiv, sourcePath, component);
					this.attachInternalLinkHandlers(groupDiv, sourcePath, component);
				} catch (secondError) {
					console.error("VirtualFooter: Failed to render content after retry:", secondError);
					const errorEl = groupDiv.createEl("div", { cls: "virtual-footer-error" });
					errorEl.createEl("p", { text: "Error rendering virtual content. Please reload the page or check the content for errors." });
				}
			}, 2000); // 2 second delay
		}

		let injectionSuccessful = false;
		const viewState = view.getState();

		// Inject based on view mode and render location
		if (viewState.mode === 'preview') { // Reading mode
			const previewContentParent = view.previewMode.containerEl;
			let targetParent: HTMLElement | null = null;
			
			if (isRenderInHeader) {
				if (renderAboveProperties) {
					// Try to find metadata container first
					targetParent = previewContentParent.querySelector<HTMLElement>(SELECTOR_METADATA_CONTAINER);
				}
				// If no metadata container or renderAboveProperties is false, use regular header
				if (!targetParent) {
					targetParent = previewContentParent.querySelector<HTMLElement>(SELECTOR_PREVIEW_HEADER_AREA);
				}
			} else { // Footer
				if (renderAboveBacklinks) {
					// Try to find embedded backlinks first
					targetParent = previewContentParent.querySelector<HTMLElement>(SELECTOR_EMBEDDED_BACKLINKS);
				}
				// If no backlinks or renderAboveBacklinks is false, use regular footer
				if (!targetParent) {
					targetParent = previewContentParent.querySelector<HTMLElement>(SELECTOR_PREVIEW_FOOTER_AREA);
				}
			}
			
			if (targetParent) {
				// Ensure idempotency: remove any existing content of this type before adding new
				if (isRenderInHeader && renderAboveProperties) {
					// Remove existing header content above properties
					view.previewMode.containerEl.querySelectorAll(`.${CSS_HEADER_GROUP_ELEMENT}.virtual-footer-above-properties`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
				} else if (isRenderInHeader && !renderAboveProperties) {
					// Remove existing normal header content
					targetParent.querySelectorAll(`.${CSS_HEADER_GROUP_ELEMENT}:not(.virtual-footer-above-properties)`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
				} else if (!isRenderInHeader && renderAboveBacklinks) {
					// Remove existing footer content above backlinks
					view.previewMode.containerEl.querySelectorAll(`.${CSS_FOOTER_GROUP_ELEMENT}.virtual-footer-above-backlinks`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
				} else if (!isRenderInHeader && !renderAboveBacklinks) {
					// Remove existing normal footer content
					targetParent.querySelectorAll(`.${CSS_FOOTER_GROUP_ELEMENT}:not(.virtual-footer-above-backlinks)`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
				}
				
				if (isRenderInHeader && !renderAboveProperties) {
					targetParent.appendChild(groupDiv);
				} else if (!isRenderInHeader && !renderAboveBacklinks) {
					targetParent.appendChild(groupDiv);
				} else {
					// Insert before properties or backlinks
					targetParent.parentElement?.insertBefore(groupDiv, targetParent);
				}
				injectionSuccessful = true;
			}
		} else if (viewState.mode === 'source') { // Live Preview or Source mode
			if (isRenderInHeader) {
				let targetParent: HTMLElement | null = null;
				
				if (renderAboveProperties) {
					// Try to find metadata container first in live preview
					targetParent = view.containerEl.querySelector<HTMLElement>(SELECTOR_METADATA_CONTAINER);
				}
				
				// If no metadata container or renderAboveProperties is false, use content container
				if (!targetParent) {
					const cmContentContainer = view.containerEl.querySelector<HTMLElement>(SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER);
					if (cmContentContainer?.parentElement) {
						// Ensure idempotency: remove existing normal header content
						cmContentContainer.parentElement.querySelectorAll(`.${CSS_HEADER_GROUP_ELEMENT}:not(.virtual-footer-above-properties)`).forEach(el => {
							const holder = el as HTMLElementWithComponent;
							holder.component?.unload();
							el.remove();
						});
						cmContentContainer.parentElement.insertBefore(groupDiv, cmContentContainer);
						injectionSuccessful = true;
					}
				} else {
					// Ensure idempotency: remove existing header content above properties
					view.containerEl.querySelectorAll(`.${CSS_HEADER_GROUP_ELEMENT}.virtual-footer-above-properties`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
					// Insert before properties
					targetParent.parentElement?.insertBefore(groupDiv, targetParent);
					injectionSuccessful = true;
				}
			} else { // Footer in Live Preview or Source mode
				let targetParent: HTMLElement | null = null;
				
				if (renderAboveBacklinks) {
					// Try to find embedded backlinks first in live preview
					targetParent = view.containerEl.querySelector<HTMLElement>(SELECTOR_EMBEDDED_BACKLINKS);
				}
				
				// If no backlinks or renderAboveBacklinks is false, use regular editor sizer
				if (!targetParent) {
					targetParent = view.containerEl.querySelector<HTMLElement>(SELECTOR_EDITOR_SIZER);
				}
				
				if (targetParent) {
					// Ensure idempotency: remove existing content of the appropriate type
					if (renderAboveBacklinks) {
						// Remove existing footer content above backlinks
						view.containerEl.querySelectorAll(`.${CSS_FOOTER_GROUP_ELEMENT}.virtual-footer-above-backlinks`).forEach(el => {
							const holder = el as HTMLElementWithComponent;
							holder.component?.unload();
							el.remove();
						});
					} else {
						// Remove existing normal footer content
						targetParent.querySelectorAll(`.${CSS_FOOTER_GROUP_ELEMENT}:not(.virtual-footer-above-backlinks)`).forEach(el => {
							const holder = el as HTMLElementWithComponent;
							holder.component?.unload();
							el.remove();
						});
					}
					
					if (!renderAboveBacklinks || targetParent.matches(SELECTOR_EDITOR_SIZER)) {
						targetParent.appendChild(groupDiv);
					} else {
						// Insert before backlinks
						targetParent.parentElement?.insertBefore(groupDiv, targetParent);
					}
					injectionSuccessful = true;
				}
			}
		}

		if (injectionSuccessful) {
			this.attachInternalLinkHandlers(groupDiv, sourcePath, component);
			return null; // Injection successful, no need to return element
		} else {
			// If injection failed in preview mode, it might be because the target DOM isn't ready.
			// Return the div to be handled by the MutationObserver.
			if (viewState.mode === 'preview') {
				console.log(`VirtualFooter: Deferring injection for ${renderLocation} in preview mode. Target not found yet.`);
				return groupDiv; // Return for deferred injection
			} else {
				// For other modes, if injection fails, unload component and log warning.
				component.unload();
				console.warn(`VirtualFooter: Failed to find injection point for dynamic content group (${renderLocation}). View mode: ${viewState.mode}.`);
				return null;
			}
		}
	}

	/**
	 * Ensures a MutationObserver is set up for a view in preview mode to handle deferred content injection.
	 * The observer watches for the appearance of target DOM elements and is careful not to act on stale data.
	 * @param view The MarkdownView to observe.
	 */
	private ensurePreviewObserver(view: MarkdownView): void {
		if (this.previewObservers.has(view) || !view.file || !view.previewMode?.containerEl) {
			return; // Observer already exists, or view/file/container not ready
		}

		const observerPath = view.file.path; // Path this observer is responsible for.

		const observer = new MutationObserver((_mutations) => {
			const pending = this.pendingPreviewInjections.get(view);

			// This observer is stale and should self-destruct if:
			// 1. The view has no file or has navigated to a different file.
			// 2. There are no pending injections for this view.
			// 3. The pending injections are for a different file.
			if (!view.file || view.file.path !== observerPath || !pending || pending.filePath !== observerPath) {
				observer.disconnect();
				// Only remove this specific observer instance from the map
				if (this.previewObservers.get(view) === observer) {
					this.previewObservers.delete(view);
				}
				return;
			}

			// If there's nothing left to inject, clean up and disconnect.
			if (!pending.headerDiv && !pending.footerDiv && !pending.headerAbovePropertiesDiv && !pending.footerAboveBacklinksDiv) {
				observer.disconnect();
				if (this.previewObservers.get(view) === observer) {
					this.previewObservers.delete(view);
				}
				this.pendingPreviewInjections.delete(view);
				return;
			}

			let allResolved = true;
			const sourcePath = view.file.path;

			// Attempt to inject pending header content
			if (pending.headerDiv) {
				const headerTargetParent = view.previewMode.containerEl.querySelector<HTMLElement>(SELECTOR_PREVIEW_HEADER_AREA);
				if (headerTargetParent) {
					// Ensure idempotency: remove any existing header content before adding new.
					headerTargetParent.querySelectorAll(`.${CSS_HEADER_GROUP_ELEMENT}`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
					headerTargetParent.appendChild(pending.headerDiv);
					if (pending.headerDiv.component) {
						this.attachInternalLinkHandlers(pending.headerDiv, sourcePath, pending.headerDiv.component);
					}
					delete pending.headerDiv; // Injection successful
				} else {
					allResolved = false; // Target not yet available
				}
			}

			// Attempt to inject pending header content above properties
			if (pending.headerAbovePropertiesDiv) {
				const headerTargetParent = view.previewMode.containerEl.querySelector<HTMLElement>(SELECTOR_METADATA_CONTAINER);
				if (headerTargetParent) {
					// Ensure idempotency: remove any existing content of this type
					view.previewMode.containerEl.querySelectorAll(`.${CSS_HEADER_GROUP_ELEMENT}.virtual-footer-above-properties`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
					// Add a class to distinguish this from regular header content
					pending.headerAbovePropertiesDiv.classList.add('virtual-footer-above-properties');
					// Insert before properties
					headerTargetParent.parentElement?.insertBefore(pending.headerAbovePropertiesDiv, headerTargetParent);
					if (pending.headerAbovePropertiesDiv.component) {
						this.attachInternalLinkHandlers(pending.headerAbovePropertiesDiv, sourcePath, pending.headerAbovePropertiesDiv.component);
					}
					delete pending.headerAbovePropertiesDiv; // Injection successful
				} else {
					allResolved = false; // Target not yet available
				}
			}

			// Attempt to inject pending footer content
			if (pending.footerDiv) {
				const footerTargetParent = view.previewMode.containerEl.querySelector<HTMLElement>(SELECTOR_PREVIEW_FOOTER_AREA);
				if (footerTargetParent) {
					// Ensure idempotency: remove any existing footer content before adding new.
					footerTargetParent.querySelectorAll(`.${CSS_FOOTER_GROUP_ELEMENT}`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
					footerTargetParent.appendChild(pending.footerDiv);
					if (pending.footerDiv.component) {
						this.attachInternalLinkHandlers(pending.footerDiv, sourcePath, pending.footerDiv.component);
					}
					delete pending.footerDiv; // Injection successful
				} else {
					allResolved = false; // Target not yet available
				}
			}

			// Attempt to inject pending footer content above backlinks
			if (pending.footerAboveBacklinksDiv) {
				const footerTargetParent = view.previewMode.containerEl.querySelector<HTMLElement>(SELECTOR_EMBEDDED_BACKLINKS);
				if (footerTargetParent) {
					// Ensure idempotency: remove any existing content of this type
					view.previewMode.containerEl.querySelectorAll(`.${CSS_FOOTER_GROUP_ELEMENT}.virtual-footer-above-backlinks`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
					// Add a class to distinguish this from regular footer content
					pending.footerAboveBacklinksDiv.classList.add('virtual-footer-above-backlinks');
					// Insert before backlinks
					footerTargetParent.parentElement?.insertBefore(pending.footerAboveBacklinksDiv, footerTargetParent);
					if (pending.footerAboveBacklinksDiv.component) {
						this.attachInternalLinkHandlers(pending.footerAboveBacklinksDiv, sourcePath, pending.footerAboveBacklinksDiv.component);
					}
					delete pending.footerAboveBacklinksDiv; // Injection successful
				} else {
					allResolved = false; // Target not yet available
				}
			}

			// If all pending injections are resolved, disconnect the observer
			if (allResolved) {
				observer.disconnect();
				if (this.previewObservers.get(view) === observer) {
					this.previewObservers.delete(view);
				}
				this.pendingPreviewInjections.delete(view);
			}
		});

		// Start observing the preview container for child and subtree changes
		observer.observe(view.previewMode.containerEl, { childList: true, subtree: true });
		this.previewObservers.set(view, observer);
	}

	/**
	 * Applies CSS classes to adjust CodeMirror (Live Preview) layout for footer content.
	 * @param view The MarkdownView in Live Preview mode.
	 */
	private applyLivePreviewFooterStyles(view: MarkdownView): void {
		const contentEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_AREA);
		const containerEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT);
		contentEl?.classList.add(CSS_VIRTUAL_FOOTER_CM_PADDING);
		containerEl?.classList.add(CSS_VIRTUAL_FOOTER_REMOVE_FLEX);
	}

	/**
	 * Removes CSS classes used for Live Preview footer layout adjustments.
	 * @param viewOrContainer The MarkdownView or a specific HTMLElement container.
	 */
	private removeLivePreviewFooterStyles(viewOrContainer: MarkdownView | HTMLElement): void {
		const container = viewOrContainer instanceof MarkdownView ? viewOrContainer.containerEl : viewOrContainer;
		const contentEl = container.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_AREA);
		const containerEl = container.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT);
		contentEl?.classList.remove(CSS_VIRTUAL_FOOTER_CM_PADDING);
		containerEl?.classList.remove(CSS_VIRTUAL_FOOTER_REMOVE_FLEX);
	}

	/**
	 * Removes all plugin-injected DOM elements from a given container.
	 * @param containerEl The HTMLElement to search within.
	 */
	private async removeInjectedContentDOM(containerEl: HTMLElement): Promise<void> {
		containerEl.querySelectorAll(`.${CSS_DYNAMIC_CONTENT_ELEMENT}`).forEach(el => {
			const componentHolder = el as HTMLElementWithComponent;
			if (componentHolder.component) {
				componentHolder.component.unload(); // Unload associated Obsidian component
			}
			el.remove(); // Remove the element from DOM
		});
	}

	/**
	 * Removes all dynamic content, styles, and observers associated with a specific view.
	 * @param view The MarkdownView to clean up.
	 */
	private async removeDynamicContentFromView(view: MarkdownView): Promise<void> {
		this.removeLivePreviewFooterStyles(view);
		await this.removeInjectedContentDOM(view.containerEl);

		// Disconnect and remove observer for this view
		const observer = this.previewObservers.get(view);
		if (observer) {
			observer.disconnect();
			this.previewObservers.delete(view);
		}

		// Clean up any pending injections for this view
		const pending = this.pendingPreviewInjections.get(view);
		if (pending) {
			pending.headerDiv?.component?.unload();
			pending.footerDiv?.component?.unload();
			this.pendingPreviewInjections.delete(view);
		}
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
		// Also clear sidebar
		this.lastSidebarContent = null;
		this.lastSeparateTabContents.clear();
		this.updateAllSidebarViews();
	}

	/**
	 * Determines which rules apply to a given file path and fetches their content.
	 * @param filePath The path of the file to check against rules.
	 * @returns A promise that resolves to an array of objects, each containing an applicable rule and its content.
	 */
	private async _getApplicableRulesAndContent(filePath: string): Promise<Array<{ rule: Rule; contentText: string; index: number }>> {
		const allApplicable: Array<{ rule: Rule; contentText: string; index: number }> = [];
		const abstractFile = this.app.vault.getAbstractFileByPath(filePath);

		if (!(abstractFile instanceof TFile)) {
			return []; // Not a valid file
		}
		const file: TFile = abstractFile;
		let fileTags: string[] | null = null; // Lazily loaded
		const fileCache = this.app.metadataCache.getFileCache(file);

		// Pre-fetch tags if any tag-based rules exist and are enabled
		const hasEnabledTagRule = this.settings.rules.some(r => r.enabled && (r.type === RuleType.Tag || r.type === RuleType.Multi));
		if (hasEnabledTagRule && fileCache) {
			const allTagsInFileWithHash = getAllTags(fileCache);
			fileTags = allTagsInFileWithHash ? allTagsInFileWithHash.map(tag => tag.substring(1)) : [];
		}

		for (const [index, currentRule] of this.settings.rules.entries()) {
			if (!currentRule.enabled) {
				continue; // Skip disabled rules
			}

			let isMatch = false;

			// --- Match by Folder ---
			if (currentRule.type === RuleType.Folder) {
				isMatch = this._checkFolderMatch(file, currentRule);
			}
			// --- Match by Tag ---
			else if (currentRule.type === RuleType.Tag) {
				isMatch = this._checkTagMatch(fileTags, currentRule);
			}
			// --- Match by Property ---
			else if (currentRule.type === RuleType.Property) {
				isMatch = this._checkPropertyMatch(fileCache?.frontmatter, currentRule);
			}
			// --- Match by Multi ---
			else if (currentRule.type === RuleType.Multi) {
				if (currentRule.conditions && currentRule.conditions.length > 0) {
					const checkCondition = (condition: SubCondition): boolean => {
						let result = false;
						if (condition.type === 'folder') {
							result = this._checkFolderMatch(file, condition);
						} else if (condition.type === 'tag') {
							result = this._checkTagMatch(fileTags, condition);
						} else if (condition.type === 'property') {
							result = this._checkPropertyMatch(fileCache?.frontmatter, condition);
						}
						
						// Apply negation if specified
						return condition.negated ? !result : result;
					};

					if (currentRule.multiConditionLogic === 'all') {
						// ALL (AND) logic: every condition must be true
						isMatch = currentRule.conditions.every(checkCondition);
					} else {
						// ANY (OR) logic: at least one condition must be true
						isMatch = currentRule.conditions.some(checkCondition);
					}
				}
			}
			// --- Match by Dataview Query ---
			else if (currentRule.type === RuleType.Dataview) {
				isMatch = await this._checkDataviewMatch(file, currentRule.dataviewQuery || '');
			}

			// Apply negation to the main rule if specified (for non-multi rules)
			if (currentRule.type !== RuleType.Multi && currentRule.negated) {
				isMatch = !isMatch;
			}

			if (isMatch) {
				const contentText = await this._fetchContentForRule(currentRule);
				allApplicable.push({ rule: currentRule, contentText, index });
			}
		}
		return allApplicable;
	}

	private _checkFolderMatch(file: TFile, rule: { path?: string, recursive?: boolean }): boolean {
		if (rule.path === undefined) return false;
		const ruleRecursive = rule.recursive === undefined ? true : rule.recursive;

		if (rule.path === "") { // Matches all files
			return true;
		} else if (rule.path === "/") { // Matches root folder
			return ruleRecursive ? true : (file.parent?.isRoot() ?? false);
		} else {
			let normalizedRuleFolderPath = rule.path.endsWith('/') ? rule.path.slice(0, -1) : rule.path;
			if (ruleRecursive) {
				return file.path.startsWith(normalizedRuleFolderPath + '/');
			} else {
				return file.parent?.path === normalizedRuleFolderPath;
			}
		}
	}

	private _checkTagMatch(fileTags: string[] | null, rule: { tag?: string, includeSubtags?: boolean }): boolean {
		if (!rule.tag || !fileTags) return false;
		const ruleTag = rule.tag;
		const includeSubtags = rule.includeSubtags ?? false;
		for (const fileTag of fileTags) {
			if (includeSubtags) {
				if (fileTag === ruleTag || fileTag.startsWith(ruleTag + '/')) {
					return true;
				}
			} else {
				if (fileTag === ruleTag) {
					return true;
				}
			}
		}
		return false;
	}

	private _checkPropertyMatch(frontmatter: any, rule: { propertyName?: string, propertyValue?: string }): boolean {
		if (!rule.propertyName || !frontmatter) return false;
		const propertyKey = rule.propertyName;
		const expectedPropertyValue = rule.propertyValue;
		const actualPropertyValue = frontmatter[propertyKey];

		// If the property exists in frontmatter
		if (actualPropertyValue !== undefined && actualPropertyValue !== null) {
			// If no expected value is specified, match any file that has this property
			if (!expectedPropertyValue || expectedPropertyValue.trim() === '') {
				return true;
			}
			
			// Smart Property Links Logic
			if (this.settings.smartPropertyLinks) {
				const resolveFile = (val: string) => {
					if (!val) return null;
					let linktext = val.trim();
					// Basic wiki-link cleaning: [[Link|Alias]] -> Link
					if (linktext.startsWith('[[') && linktext.endsWith(']]')) {
						linktext = linktext.substring(2, linktext.length - 2);
						const pipeIndex = linktext.indexOf('|');
						if (pipeIndex >= 0) {
							linktext = linktext.substring(0, pipeIndex);
						}
					}
					return this.app.metadataCache.getFirstLinkpathDest(linktext, '');
				};

				const expectedFile = resolveFile(expectedPropertyValue);
				if (expectedFile) {
					const checkValue = (val: any) => {
						if (typeof val !== 'string') return false;
						const actualFile = resolveFile(val);
						return actualFile !== null && actualFile.path === expectedFile.path;
					};

					if (Array.isArray(actualPropertyValue)) {
						if (actualPropertyValue.some(checkValue)) return true;
					} else {
						if (checkValue(actualPropertyValue)) return true;
					}
				}
			}
			
			// Otherwise, check for exact value match
			if (typeof actualPropertyValue === 'string') {
				return actualPropertyValue === expectedPropertyValue;
			} else if (Array.isArray(actualPropertyValue)) {
				// For arrays, check if the expected value is one of the items
				return actualPropertyValue.map(String).includes(expectedPropertyValue);
			} else if (typeof actualPropertyValue === 'number' || typeof actualPropertyValue === 'boolean') {
				return String(actualPropertyValue) === expectedPropertyValue;
			}
		}
		return false;
	}

	/**
	 * Checks if a file matches a Dataview query rule
	 * @param file The file to check against the dataview query
	 * @param query The dataview query string
	 * @returns True if the file matches the dataview query, false otherwise
	 */
	private async _checkDataviewMatch(file: TFile, query: string): Promise<boolean> {
		// Check if dataview plugin exists
		// @ts-ignore - Access plugins using bracket notation
		const dataviewPlugin = this.app.plugins.plugins?.dataview;
		if (!dataviewPlugin) {
			console.warn("VirtualFooter: Dataview plugin is required for dataview rules but is not installed or enabled.");
			return false;
		}
		
		try {
			const dataviewApi = dataviewPlugin.api;
			if (!dataviewApi) {
				console.warn("VirtualFooter: Cannot access Dataview API.");
				return false;
			}
			
			// Execute the query against the active file
			const results = await dataviewApi.query(query);

			// Dataview API returns a Success object with a 'successful' flag and 'value' property
			if (!results || !results.successful || !results.value || !Array.isArray(results.value.values)) {
				// If the query did not return valid results, log and return false
				console.warn(`VirtualFooter: Dataview query did not return valid results for query: ${query} in file: ${file.path} Dataview error:`, results);
				return false;
			}

			// Extract file paths from the results
			const resultPaths: string[] = [];
			for (const page of results.value.values) {
				if (page.path) {
					resultPaths.push(page.path);
			 }
			}

			// Check if current file path is in the results
			return resultPaths.includes(file.path);
		} catch (error) {
			console.error(`VirtualFooter: Error executing Dataview query: ${query}`, error);
			return false;
		}
	}

	/**
	 * Fetches the content for a given rule, either from direct text or from a specified file.
	 * @param rule The rule for which to fetch content.
	 * @returns A promise that resolves to the content string.
	 */
	private async _fetchContentForRule(rule: Rule): Promise<string> {
		if (rule.contentSource === ContentSource.File && rule.footerFilePath) {
			const file = this.app.vault.getAbstractFileByPath(rule.footerFilePath);
			if (file instanceof TFile) {
				try {
					return await this.app.vault.cachedRead(file);
				} catch (error) {
					console.error(`VirtualFooter: Error reading content file ${rule.footerFilePath}`, error);
					return `<!-- Error reading content file: ${rule.footerFilePath} -->`; // Return error message in content
				}
			} else {
				console.warn(`VirtualFooter: Content file not found for rule: ${rule.footerFilePath}`);
				return `<!-- Content file not found: ${rule.footerFilePath} -->`; // Return warning in content
			}
		}
		return rule.footerText || ""; // Use direct text or empty string if not file
	}

	/**
	 * Attaches event handlers to the injected content for internal link navigation.
	 * @param container The HTMLElement containing the rendered Markdown.
	 * @param sourcePath The path of the file where the content is injected, for link resolution.
	 * @param component The Obsidian Component associated with this content, for event registration.
	 */
	public attachInternalLinkHandlers(container: HTMLElement, sourcePath: string, component: Component): void {
		// Handle left-click on internal links
		component.registerDomEvent(container, 'click', (event: MouseEvent) => {
			if (event.button !== 0) return; // Only handle left-clicks
			const target = event.target as HTMLElement;
			const linkElement = target.closest('a.internal-link') as HTMLAnchorElement;
			if (linkElement) {
				event.preventDefault(); // Prevent default link navigation
				const href = linkElement.dataset.href;
				if (href) {
					const inNewPane = event.ctrlKey || event.metaKey; // Open in new pane if Ctrl/Cmd is pressed
					this.app.workspace.openLinkText(href, sourcePath, inNewPane);
				}
			}
		});

		// Handle middle-click (auxclick) on internal links to open in a new pane
		component.registerDomEvent(container, 'auxclick', (event: MouseEvent) => {
			if (event.button !== 1) return; // Only handle middle-clicks
			const target = event.target as HTMLElement;
			const linkElement = target.closest('a.internal-link') as HTMLAnchorElement;
			if (linkElement) {
				event.preventDefault();
				const href = linkElement.dataset.href;
				if (href) {
					this.app.workspace.openLinkText(href, sourcePath, true); // Always open in new pane for middle-click
				}
			}
		});
	}

	/**
	 * Loads plugin settings from storage, migrating old formats if necessary.
	 */
	async loadSettings() {
		const loadedData = await this.loadData();
		// Start with a deep copy of default settings to ensure all fields are present
		this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

		if (loadedData) {
			// Handle potential old global renderLocation setting for migration
			const oldGlobalRenderLocation = loadedData.renderLocation as RenderLocation | undefined;

			if (loadedData.rules && Array.isArray(loadedData.rules)) {
				this.settings.rules = loadedData.rules.map((loadedRule: any) =>
					this._migrateRule(loadedRule, oldGlobalRenderLocation)
				);
			}
			// Load the new refreshOnFileOpen setting if it exists in loadedData
			if (typeof loadedData.refreshOnFileOpen === 'boolean') {
				this.settings.refreshOnFileOpen = loadedData.refreshOnFileOpen;
			}
			// Load the new renderInSourceMode setting if it exists
			if (typeof loadedData.renderInSourceMode === 'boolean') {
				this.settings.renderInSourceMode = loadedData.renderInSourceMode;
			}
			// Load the new refreshOnMetadataChange setting if it exists
			if (typeof loadedData.refreshOnMetadataChange === 'boolean') {
				this.settings.refreshOnMetadataChange = loadedData.refreshOnMetadataChange;
			}
			// Load the new smartPropertyLinks setting if it exists
			if (typeof loadedData.smartPropertyLinks === 'boolean') {
				this.settings.smartPropertyLinks = loadedData.smartPropertyLinks;
			}
		}

		// Ensure there's at least one rule, and all rules are normalized
		if (!this.settings.rules || this.settings.rules.length === 0) {
			// If no rules exist, add a default one
			this.settings.rules = [JSON.parse(JSON.stringify(DEFAULT_SETTINGS.rules[0]))];
			this.normalizeRule(this.settings.rules[0]);
		} else {
			// Normalize all existing rules
			this.settings.rules.forEach(rule => this.normalizeRule(rule));
		}
		// Ensure global settings are definitely booleans
		if (typeof this.settings.refreshOnFileOpen !== 'boolean') {
			this.settings.refreshOnFileOpen = DEFAULT_SETTINGS.refreshOnFileOpen!;
		}
		if (typeof this.settings.renderInSourceMode !== 'boolean') {
			this.settings.renderInSourceMode = DEFAULT_SETTINGS.renderInSourceMode!;
		}
		if (typeof this.settings.refreshOnMetadataChange !== 'boolean') {
			this.settings.refreshOnMetadataChange = DEFAULT_SETTINGS.refreshOnMetadataChange!;
		}
		if (typeof this.settings.smartPropertyLinks !== 'boolean') {
			this.settings.smartPropertyLinks = DEFAULT_SETTINGS.smartPropertyLinks!;
		}
	}

	/**
	 * Migrates a rule from an older settings format to the current Rule interface.
	 * @param loadedRule The rule object loaded from storage.
	 * @param globalRenderLocation An optional global render location from a very old settings format.
	 * @returns A migrated and normalized Rule object.
	 */
	private _migrateRule(loadedRule: any, globalRenderLocation?: RenderLocation): Rule {
		// Determine rule type, defaulting if ambiguous
		let type: RuleType;
		if (Object.values(RuleType).includes(loadedRule.type as RuleType)) {
			type = loadedRule.type as RuleType;
		} else if (typeof loadedRule.folderPath === 'string') { // Legacy field
			type = RuleType.Folder;
		} else {
			type = DEFAULT_SETTINGS.rules[0].type;
		}

		// Determine content source, defaulting if ambiguous
		let contentSource: ContentSource;
		if (Object.values(ContentSource).includes(loadedRule.contentSource as ContentSource)) {
			contentSource = loadedRule.contentSource as ContentSource;
		} else {
			// If folderPath existed (legacy) and contentSource is undefined, it was likely Text
			contentSource = (typeof loadedRule.folderPath === 'string' && loadedRule.contentSource === undefined)
				? ContentSource.Text
				: DEFAULT_SETTINGS.rules[0].contentSource;
		}

		const migratedRule: Rule = {
			name: loadedRule.name || DEFAULT_SETTINGS.rules[0].name,
			enabled: loadedRule.enabled !== undefined ? loadedRule.enabled : DEFAULT_SETTINGS.rules[0].enabled,
			type: type,
			contentSource: contentSource,
			footerText: loadedRule.footerText || '', // Retain name for compatibility
			renderLocation: loadedRule.renderLocation || globalRenderLocation || DEFAULT_SETTINGS.rules[0].renderLocation,
			recursive: loadedRule.recursive !== undefined ? loadedRule.recursive : true,
			showInSeparateTab: loadedRule.showInSeparateTab || false,
			sidebarTabName: loadedRule.sidebarTabName || '',
			multiConditionLogic: loadedRule.multiConditionLogic || 'any',
			renderAboveProperties: loadedRule.renderAboveProperties !== undefined ? loadedRule.renderAboveProperties : undefined,
			renderAboveBacklinks: loadedRule.renderAboveBacklinks !== undefined ? loadedRule.renderAboveBacklinks : undefined,
			dataviewQuery: loadedRule.dataviewQuery || '',
			footerFilePath: loadedRule.footerFilePath || '', // Retained name for compatibility
			showInPopover: loadedRule.showInPopover !== undefined ? loadedRule.showInPopover : true,
		};

		// Populate type-specific fields
		if (migratedRule.type === RuleType.Folder) {
			migratedRule.path = loadedRule.path !== undefined ? loadedRule.path :
				(loadedRule.folderPath !== undefined ? loadedRule.folderPath : DEFAULT_SETTINGS.rules[0].path);
		} else if (migratedRule.type === RuleType.Tag) {
			migratedRule.tag = loadedRule.tag !== undefined ? loadedRule.tag : '';
			migratedRule.includeSubtags = loadedRule.includeSubtags !== undefined ? loadedRule.includeSubtags : false;
		} else if (migratedRule.type === RuleType.Property) {
			migratedRule.propertyName = loadedRule.propertyName || '';
			migratedRule.propertyValue = loadedRule.propertyValue || '';
		} else if (migratedRule.type === RuleType.Multi) {
			migratedRule.conditions = loadedRule.conditions || [];
		}

		// Populate content source-specific fields
		if (migratedRule.contentSource === ContentSource.File) {
			migratedRule.footerFilePath = loadedRule.footerFilePath || ''; // Retained name for compatibility
		}
		return migratedRule; // Normalization will happen after migration
	}

	/**
	 * Normalizes a rule object, ensuring all required fields are present and defaults are applied.
	 * Also cleans up fields that are not relevant to the rule's current type or content source.
	 * @param rule The rule to normalize.
	 */
	public normalizeRule(rule: Rule): void {
		// Create a copy of the rule to preserve original values during cleanup
		const originalRule = { ...rule };

		// Ensure basic fields have default values
		rule.name = rule.name === undefined ? DEFAULT_SETTINGS.rules[0].name : rule.name;
		rule.enabled = typeof rule.enabled === 'boolean' ? rule.enabled : DEFAULT_SETTINGS.rules[0].enabled!;
		rule.type = rule.type || DEFAULT_SETTINGS.rules[0].type;

		// Clean up all type-specific fields before re-populating
		delete rule.path;
		delete rule.recursive;
		delete rule.tag;
		delete rule.includeSubtags;
		delete rule.propertyName;
		delete rule.propertyValue;
		delete rule.conditions;
		delete rule.multiConditionLogic;
		delete rule.dataviewQuery;

		// Normalize based on RuleType, using values from the original rule if they exist
		if (rule.type === RuleType.Folder) {
			rule.path = originalRule.path === undefined ? (DEFAULT_SETTINGS.rules[0].path || '') : originalRule.path;
			// 'recursive' is always true if path is "" (all files)
			rule.recursive = rule.path === "" ? true : (typeof originalRule.recursive === 'boolean' ? originalRule.recursive : true);
		} else if (rule.type === RuleType.Tag) {
			rule.tag = originalRule.tag === undefined ? '' : originalRule.tag;
			rule.includeSubtags = typeof originalRule.includeSubtags === 'boolean' ? originalRule.includeSubtags : false;
		} else if (rule.type === RuleType.Property) {
			rule.propertyName = originalRule.propertyName === undefined ? '' : originalRule.propertyName;
			rule.propertyValue = originalRule.propertyValue === undefined ? '' : originalRule.propertyValue;
		} else if (rule.type === RuleType.Multi) {
			rule.conditions = Array.isArray(originalRule.conditions) ? originalRule.conditions : [];
			rule.multiConditionLogic = originalRule.multiConditionLogic === 'all' ? 'all' : 'any';
		} else if (rule.type === RuleType.Dataview) {
			rule.dataviewQuery = originalRule.dataviewQuery === undefined ? '' : originalRule.dataviewQuery;
		}

		// Normalize content source and related fields
		rule.contentSource = originalRule.contentSource || DEFAULT_SETTINGS.rules[0].contentSource;
		rule.footerText = originalRule.footerText || ''; // Retain name for compatibility
		rule.renderLocation = originalRule.renderLocation || DEFAULT_SETTINGS.rules[0].renderLocation;

		if (rule.contentSource === ContentSource.File) {
			rule.footerFilePath = originalRule.footerFilePath || ''; // Retain name for compatibility
		} else { // ContentSource.Text
			delete rule.footerFilePath;
		}

		// Normalize sidebar-specific fields
		if (rule.renderLocation === RenderLocation.Sidebar) {
			rule.showInSeparateTab = typeof originalRule.showInSeparateTab === 'boolean' ? originalRule.showInSeparateTab : false;
			rule.sidebarTabName = originalRule.sidebarTabName || '';
		} else {
			delete rule.showInSeparateTab;
			delete rule.sidebarTabName;
		}

		// Normalize positioning fields based on render location
		if (rule.renderLocation === RenderLocation.Header) {
			rule.renderAboveProperties = typeof originalRule.renderAboveProperties === 'boolean' ? originalRule.renderAboveProperties : false;
			delete rule.renderAboveBacklinks;
		} else if (rule.renderLocation === RenderLocation.Footer) {
			rule.renderAboveBacklinks = typeof originalRule.renderAboveBacklinks === 'boolean' ? originalRule.renderAboveBacklinks : false;
			delete rule.renderAboveProperties;
		} else {
			delete rule.renderAboveProperties;
			delete rule.renderAboveBacklinks;
		}

		// Normalize popover visibility setting
		rule.showInPopover = typeof originalRule.showInPopover === 'boolean' ? originalRule.showInPopover : true;
	}

	/**
	 * Saves the current plugin settings to storage and triggers a view refresh.
	 */
	async saveSettings() {
		// Ensure all rules are normalized before saving
		this.settings.rules.forEach(rule => this.normalizeRule(rule));
		await this.saveData(this.settings);
		this.registerDynamicViews(); // Re-register views in case names/rules changed
		this.handleActiveViewChange(); // Refresh views to apply changes
	}

	async activateView(viewId: string) {
		this.app.workspace.detachLeavesOfType(viewId);

		const leaf = this.app.workspace.getRightLeaf(true);
		if (leaf) {
			await leaf.setViewState({
				type: viewId,
				active: true,
			});

			this.app.workspace.revealLeaf(leaf);
		}
	}

	private activateAllSidebarViews() {
		this.activateView(VIRTUAL_CONTENT_VIEW_TYPE);
		this.settings.rules.forEach((rule, index) => {
			if (rule.enabled && rule.renderLocation === RenderLocation.Sidebar && rule.showInSeparateTab) {
				this.activateView(this.getSeparateViewId(index));
			}
		});
	}

	private updateAllSidebarViews() {
		const leaves = this.app.workspace.getLeavesOfType(VIRTUAL_CONTENT_VIEW_TYPE);
		for (const leaf of leaves) {
			if (leaf.view instanceof VirtualContentView) {
				leaf.view.update();
			}
		}
		this.settings.rules.forEach((rule, index) => {
			if (rule.renderLocation === RenderLocation.Sidebar && rule.showInSeparateTab) {
				const viewId = this.getSeparateViewId(index);
				const separateLeaves = this.app.workspace.getLeavesOfType(viewId);
				for (const leaf of separateLeaves) {
					if (leaf.view instanceof VirtualContentView) {
						leaf.view.update();
					}
				}
			}
		});
	}

	public getLastSidebarContent(): { content: string, sourcePath: string } | null {
		return this.lastSidebarContent;
	}

	public getSeparateTabContent(viewId: string): { content: string, sourcePath: string } | null {
		return this.lastSeparateTabContents.get(viewId) || null;
	}

	private getSeparateViewId(ruleIndex: number): string {
		return `${VIRTUAL_CONTENT_SEPARATE_VIEW_TYPE_PREFIX}${ruleIndex}`;
	}

	private registerDynamicViews() {
		this.settings.rules.forEach((rule, index) => {
			if (rule.renderLocation === RenderLocation.Sidebar && rule.showInSeparateTab) {
				const viewId = this.getSeparateViewId(index);
				const tabName = rule.sidebarTabName?.trim() ? `Virtual Content: ${rule.sidebarTabName}` : `Virtual Content: Rule ${index + 1}`;
				this.registerView(
					viewId,
					(leaf) => new VirtualContentView(leaf, this, viewId, tabName, () => this.getSeparateTabContent(viewId))
				);
			}
		});
	}
}

// --- Settings Tab Class ---

/**
 * Manages the settings tab UI for the VirtualFooter plugin.
 * Allows users to configure rules for dynamic content injection.
 */
class VirtualFooterSettingTab extends PluginSettingTab {
	// Caches for suggestion lists to improve performance
	private allFolderPathsCache: Set<string> | null = null;
	private allTagsCache: Set<string> | null = null;
	private allMarkdownFilePathsCache: Set<string> | null = null;
	private allPropertyNamesCache: Set<string> | null = null;
	private ruleExpandedStates: boolean[] = [];
	private debouncedSave: () => void;
	private debouncedSaveAndRefresh: () => void;


	constructor(app: App, private plugin: VirtualFooterPlugin) {
		super(app, plugin);
		this.debouncedSave = debounce(() => this.plugin.saveSettings(), 1000, true);
		this.debouncedSaveAndRefresh = debounce(() => {
			this.plugin.saveSettings().then(() => this.display());
		}, 1000, true);
	}

	/**
	 * Lazily gets and caches all unique folder paths in the vault.
	 * Includes special paths "" (all files) and "/" (root).
	 * @returns A set of available folder paths.
	 */
	private getAvailableFolderPaths(): Set<string> {
		if (this.allFolderPathsCache) return this.allFolderPathsCache;

		const paths = new Set<string>(['/', '']); // Special paths
		this.app.vault.getAllLoadedFiles().forEach(file => {
			if (file.parent) { // Has a parent folder
				const parentPath = file.parent.isRoot() ? '/' : (file.parent.path.endsWith('/') ? file.parent.path : file.parent.path + '/');
				if (parentPath !== '/') paths.add(parentPath); // Add parent path, ensuring trailing slash
			}
			// If the file itself is a folder (Obsidian's TFolder)
			if ('children' in file && file.path !== '/') { // 'children' indicates a TFolder
				const folderPath = file.path.endsWith('/') ? file.path : file.path + '/';
				paths.add(folderPath); // Add folder path, ensuring trailing slash
			}
		});
		this.allFolderPathsCache = paths;
		return paths;
	}

	/**
	 * Lazily gets and caches all unique tags (without '#') present in Markdown files.
	 * @returns A set of available tags.
	 */
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

	/**
	 * Lazily gets and caches all Markdown file paths in the vault.
	 * @returns A set of available Markdown file paths.
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
	 * Lazily gets and caches all unique frontmatter property keys from Markdown files.
	 * @returns A set of available property names.
	 */
	private getAvailablePropertyNames(): Set<string> {
		if (this.allPropertyNamesCache) return this.allPropertyNamesCache;

		// @ts-ignore - getFrontmatterPropertyKeys is an undocumented API, but widely used.
		const keys = this.app.metadataCache.getFrontmatterPropertyKeys?.() || [];
		this.allPropertyNamesCache = new Set(keys);
		return this.allPropertyNamesCache;
	}

	/**
	 * Renders the settings tab UI.
	 * This method is called by Obsidian when the settings tab is opened.
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty(); // Clear previous content

		// --- Plugin Header ---
		containerEl.createEl('h2', { text: 'Virtual Content Settings' });
		containerEl.createEl('p', { text: 'Define rules to dynamically add content to the header or footer of notes based on their folder, tags, or properties.' });

		// --- General Settings Section ---
		new Setting(containerEl)
			.setName('Render in source mode')
			.setDesc('If enabled, virtual content will be rendered in source mode. By default, content only appears in Live Preview and Reading modes.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.renderInSourceMode!)
				.onChange(async (value) => {
					this.plugin.settings.renderInSourceMode = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Refresh on focus change')
			.setDesc('If enabled, virtual content will refresh when switching files. This may cause a slight flicker but is useful if you frequently change the text of virtual content and need immediate updates. If disabled the virtual content will be updated on file open and view change (editing/reading view). To prevent virtual content in the sidebar disappearing when clicking out of a note, it will always keep the last notes virtual content open, which means new tabs will show the virtual content of the last used note. Disabled by default.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.refreshOnFileOpen!) // Value is ensured by loadSettings
				.onChange(async (value) => {
					this.plugin.settings.refreshOnFileOpen = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Refresh on metadata change')
			.setDesc('If enabled, virtual content will refresh when the current note\'s metadata (frontmatter, tags) changes. This is useful for rules that depend on properties or tags and need to update immediately when those values change.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.refreshOnMetadataChange!)
				.onChange(async (value) => {
					this.plugin.settings.refreshOnMetadataChange = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Smart property links')
			.setDesc('If enabled, property conditions that look like links will match against the resolved file. This allows matching aliases or different link formats (e.g. [[Note]] matches [[Note|Alias]]).')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.smartPropertyLinks!)
				.onChange(async (value) => {
					this.plugin.settings.smartPropertyLinks = value;
					await this.plugin.saveSettings();
				}));
		
		containerEl.createEl('h3', { text: 'Rules' });


		// Invalidate caches to ensure fresh suggestions each time the tab is displayed
		this.allFolderPathsCache = null;
		this.allTagsCache = null;
		this.allMarkdownFilePathsCache = null;
		this.allPropertyNamesCache = null;

		// Synchronize ruleExpandedStates with the current number of rules
		const numRules = this.plugin.settings.rules.length;
		while (this.ruleExpandedStates.length < numRules) {
			this.ruleExpandedStates.push(false); // Default new rules to collapsed
		}
		if (this.ruleExpandedStates.length > numRules) {
			this.ruleExpandedStates.length = numRules; // Truncate if rules were removed
		}


		const rulesContainer = containerEl.createDiv('rules-container virtual-footer-rules-container');

		// Ensure settings.rules array exists and has at least one rule
		if (!this.plugin.settings.rules) {
			this.plugin.settings.rules = [];
		}
		if (this.plugin.settings.rules.length === 0) {
			const newRule = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.rules[0]));
			this.plugin.normalizeRule(newRule); // Normalize the new default rule
			this.plugin.settings.rules.push(newRule);
			// Ensure ruleExpandedStates is updated for the new rule
			if (this.ruleExpandedStates.length === 0) {
				this.ruleExpandedStates.push(false);
			}
		}

		// Render controls for each rule
		this.plugin.settings.rules.forEach((rule, index) => {
			this.renderRuleControls(rule, index, rulesContainer);
		});

		// --- Add New Rule Button ---
		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('Add new rule')
				.setCta() // Call to action style
				.setClass('virtual-footer-add-button')
				.onClick(async () => {
					const newRule = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.rules[0]));
					this.plugin.normalizeRule(newRule);
					this.plugin.settings.rules.push(newRule);
					this.ruleExpandedStates.push(true); // New rule is initially expanded
					await this.plugin.saveSettings();
					this.display(); // Re-render to show the new rule and update indices
				}));
	}

	/**
	 * Renders the UI controls for a single rule within the settings tab.
	 * @param rule The rule object to render controls for.
	 * @param index The index of the rule in the settings array.
	 * @param containerEl The parent HTMLElement to append the rule controls to.
	 */
	private renderRuleControls(rule: Rule, index: number, containerEl: HTMLElement): void {
		const ruleDiv = containerEl.createDiv('rule-item virtual-footer-rule-item');
		
		// Apply stored expansion state or default to collapsed
		if (!this.ruleExpandedStates[index]) {
			ruleDiv.addClass('is-collapsed');
		}

		const ruleNameDisplay = (rule.name && rule.name.trim() !== '') ? rule.name : 'Unnamed Rule';
		const ruleHeadingText = `Rule ${index + 1}: ${ruleNameDisplay}`;
		const ruleHeading = ruleDiv.createEl('h4', { text: ruleHeadingText });
		ruleHeading.addClass('virtual-footer-rule-heading');


		const ruleContentContainer = ruleDiv.createDiv('virtual-footer-rule-content');

		// Toggle collapse/expand on heading click and update state
		ruleHeading.addEventListener('click', () => {
			const isNowExpanded = !ruleDiv.classList.toggle('is-collapsed');
			this.ruleExpandedStates[index] = isNowExpanded;
		});

		// --- Rule Name Setting ---
		new Setting(ruleContentContainer)
			.setName('Rule name')
			.setDesc('A descriptive name for this rule (e.g., "Project Notes Footer").')
			.addText(text => text
				.setPlaceholder('e.g., Blog Post Footer')
				.setValue(rule.name || '')
				.onChange((value) => {
					rule.name = value;
					// Update heading text dynamically
					const newNameDisplay = (value && value.trim() !== '') ? value : 'Unnamed Rule';
					ruleHeading.textContent = `Rule ${index + 1}: ${newNameDisplay}`;
					this.debouncedSave();
				}));

		// --- Enabled/Disabled Toggle ---
		new Setting(ruleContentContainer)
			.setName('Enabled')
			.setDesc('If disabled, this rule will not be applied.')
			.addToggle((toggle: any) => toggle
				.setValue(rule.enabled!) // normalizeRule ensures 'enabled' is boolean
				.onChange(async (value: boolean) => {
					rule.enabled = value;
					await this.plugin.saveSettings();
				}));

		// --- Rule Type Setting ---
		new Setting(ruleContentContainer)
			.setName('Rule type')
			.setDesc('Apply this rule based on folder, tag, property, or a combination.')
			.addDropdown(dropdown => dropdown
				.addOption(RuleType.Folder, 'Folder')
				.addOption(RuleType.Tag, 'Tag')
				.addOption(RuleType.Property, 'Property')
				.addOption(RuleType.Multi, 'Multi-condition')
				.addOption(RuleType.Dataview, 'Dataview')
				.setValue(rule.type)
				.onChange(async (value: string) => {
					rule.type = value as RuleType;
					// When switching to Multi, we might want to convert the old rule
					if (rule.type === RuleType.Multi) {
						const oldRule = { ...rule };
						rule.conditions = [];
						// This logic is complex, so for now we just start with a clean slate.
						// A more advanced version could auto-convert the previous simple rule.
					}
					this.plugin.normalizeRule(rule); // Re-normalize for type-specific fields
					await this.plugin.saveSettings();
					this.display(); // Re-render to show/hide type-specific settings
				}));

		// --- Type-Specific Settings ---
		if (rule.type === RuleType.Folder) {
			new Setting(ruleContentContainer)
				.setName('Condition')
				.setDesc('Choose whether this condition should be met or not met.')
				.addDropdown(dropdown => dropdown
					.addOption('is', 'is')
					.addOption('not', 'not')
					.setValue(rule.negated ? 'not' : 'is')
					.onChange(async (value: 'is' | 'not') => {
						rule.negated = value === 'not';
						await this.plugin.saveSettings();
					})
				);

			new Setting(ruleContentContainer)
				.setName('Folder path')
				.setDesc('Path for the rule. Use "" for all files, "/" for root folder, or "FolderName/" for specific folders (ensure trailing slash for non-root folders).')
				.addText(text => {
					text.setPlaceholder('e.g., Meetings/, /, or empty for all')
						.setValue(rule.path || '')
						.onChange((value) => {
							rule.path = value;
							this.plugin.normalizeRule(rule); // Normalize path and recursive flag
							this.debouncedSaveAndRefresh();
						});
					// Attach suggestion provider for folder paths
					new MultiSuggest(text.inputEl, this.getAvailableFolderPaths(), (selectedPath) => {
						rule.path = selectedPath;
						this.plugin.normalizeRule(rule);
						text.setValue(selectedPath); // Update text field with selection
						this.plugin.saveSettings().then(() => this.display());
					}, this.plugin.app);
				});

			new Setting(ruleContentContainer)
				.setName('Include subfolders (recursive)')
				.setDesc('If enabled, rule applies to files in subfolders. For "all files" (empty path), this is always true. For root path ("/"), enabling applies to all vault files, disabling applies only to files directly in the root.')
				.addToggle(toggle => {
					toggle.setValue(rule.recursive!) // normalizeRule ensures 'recursive' is boolean
						.onChange(async (value) => {
							rule.recursive = value;
							await this.plugin.saveSettings();
						});
					// Disable toggle if path is "" (all files), as recursive is always true
					if (rule.path === "") {
						toggle.setDisabled(true);
					}
				});

		} else if (rule.type === RuleType.Tag) {
			new Setting(ruleContentContainer)
				.setName('Condition')
				.setDesc('Choose whether this condition should be met or not met.')
				.addDropdown(dropdown => dropdown
					.addOption('is', 'is')
					.addOption('not', 'not')
					.setValue(rule.negated ? 'not' : 'is')
					.onChange(async (value: 'is' | 'not') => {
						rule.negated = value === 'not';
						await this.plugin.saveSettings();
					})
				);

			new Setting(ruleContentContainer)
				.setName('Tag value')
				.setDesc('Tag to match (without the # prefix). E.g., "project" or "status/done".')
				.addText(text => {
					text.setPlaceholder('e.g., important or project/alpha')
						.setValue(rule.tag || '')
						.onChange((value) => {
							// Ensure tag doesn't start with '#'
							rule.tag = value.startsWith('#') ? value.substring(1) : value;
							this.debouncedSave();
						});
					new MultiSuggest(text.inputEl, this.getAvailableTags(), (selectedTag) => {
						const normalizedTag = selectedTag.startsWith('#') ? selectedTag.substring(1) : selectedTag;
						rule.tag = normalizedTag;
						text.setValue(normalizedTag);
						this.plugin.saveSettings();
					}, this.plugin.app);
				});

			new Setting(ruleContentContainer)
				.setName('Include subtags')
				.setDesc("If enabled, a rule for 'tag' will also apply to 'tag/subtag1', 'tag/subtag2/subtag3', etc. If disabled, it only applies to the exact tag.")
				.addToggle(toggle => {
					toggle.setValue(rule.includeSubtags!) // normalizeRule ensures 'includeSubtags' is boolean
						.onChange(async (value) => {
							rule.includeSubtags = value;
							await this.plugin.saveSettings();
						});
				});
		} else if (rule.type === RuleType.Property) {
			new Setting(ruleContentContainer)
				.setName('Condition')
				.setDesc('Choose whether this condition should be met or not met.')
				.addDropdown(dropdown => dropdown
					.addOption('is', 'is')
					.addOption('not', 'not')
					.setValue(rule.negated ? 'not' : 'is')
					.onChange(async (value: 'is' | 'not') => {
						rule.negated = value === 'not';
						await this.plugin.saveSettings();
					})
				);

			new Setting(ruleContentContainer)
				.setName('Property name')
				.setDesc('The name of the Obsidian property (frontmatter key) to match.')
				.addText(text => {
					text.setPlaceholder('e.g., status, type, author')
						.setValue(rule.propertyName || '')
						.onChange((value) => {
							rule.propertyName = value;
							this.debouncedSave();
						});
					new MultiSuggest(text.inputEl, this.getAvailablePropertyNames(), (selectedName) => {
						rule.propertyName = selectedName;
						text.setValue(selectedName);
						this.plugin.saveSettings();
					}, this.plugin.app);
				});

			new Setting(ruleContentContainer)
				.setName('Property value')
				.setDesc('The value the property should have. Leave empty to match any file that has this property (regardless of value). For list/array properties, matches if this value is one of the items.')
				.addText(text => text
					.setPlaceholder('e.g., complete, article, John Doe (or leave empty)')
					.setValue(rule.propertyValue || '')
					.onChange((value) => {
						rule.propertyValue = value;
						this.debouncedSave();
					}));
		} else if (rule.type === RuleType.Multi) {
			this.renderMultiConditionControls(rule, ruleContentContainer);
		} else if (rule.type === RuleType.Dataview) {
			new Setting(ruleContentContainer)
				.setName('Condition')
				.setDesc('Choose whether this condition should be met or not met.')
				.addDropdown(dropdown => dropdown
					.addOption('is', 'is')
					.addOption('not', 'not')
					.setValue(rule.negated ? 'not' : 'is')
					.onChange(async (value: 'is' | 'not') => {
						rule.negated = value === 'not';
						await this.plugin.saveSettings();
					})
				);

			new Setting(ruleContentContainer)
				.setName('Dataview query')
				.setDesc('Enter a Dataview LIST query to match notes where this rule should apply.')
				.addTextArea(text => text
					.setPlaceholder('LIST FROM "References/Authors" WHERE startswith(file.name, "Test") OR startswith(file.name, "Example")')
					.setValue(rule.dataviewQuery || '')
					.onChange((value) => {
						rule.dataviewQuery = value;
						this.debouncedSave();
					}));

			const infoDiv = ruleContentContainer.createDiv('dataview-info');
			infoDiv.createEl('p', { 
				text: 'Note: The Dataview plugin must be installed for this rule type to work.',
				cls: 'setting-item-description'
			});
		}

		// --- Content Source Settings ---
		new Setting(ruleContentContainer)
			.setName('Content source')
			.setDesc('Where to get the content from: direct text input or a separate Markdown file.')
			.addDropdown(dropdown => dropdown
				.addOption(ContentSource.Text, 'Direct text')
				.addOption(ContentSource.File, 'Markdown file')
				.setValue(rule.contentSource || ContentSource.Text) // Default to Text if undefined
				.onChange(async (value: string) => {
					rule.contentSource = value as ContentSource;
					this.plugin.normalizeRule(rule); // Normalize for content source specific fields
					await this.plugin.saveSettings();
					this.display(); // Re-render to show/hide content source specific fields
				}));

		if (rule.contentSource === ContentSource.File) {
			new Setting(ruleContentContainer)
				.setName('Content file path')
				.setDesc('Path to the .md file to use as content (e.g., "templates/common-footer.md").')
				.addText(text => {
					text.setPlaceholder('e.g., templates/common-footer.md')
						.setValue(rule.footerFilePath || '') // Retained name for compatibility
						.onChange((value) => {
							rule.footerFilePath = value;
							this.debouncedSave();
						});
					new MultiSuggest(text.inputEl, this.getAvailableMarkdownFilePaths(), (selectedPath) => {
						rule.footerFilePath = selectedPath;
						text.setValue(selectedPath);
						this.plugin.saveSettings();
					}, this.plugin.app);
				});
		} else { // ContentSource.Text
			new Setting(ruleContentContainer)
				.setName('Content text')
				.setDesc('Markdown text to display. This will be rendered.')
				.addTextArea(text => text
					.setPlaceholder('Enter your markdown content here...\nSupports multiple lines and **Markdown** formatting.')
					.setValue(rule.footerText || '') // Retained name for compatibility
					.onChange((value) => {
						rule.footerText = value;
						this.debouncedSave();
					}));
		}

		// --- Render Location Setting ---
		new Setting(ruleContentContainer)
			.setName('Render location')
			.setDesc('Choose whether this rule renders its content in the header, footer, or a dedicated sidebar tab.')
			.addDropdown(dropdown => dropdown
				.addOption(RenderLocation.Footer, 'Footer')
				.addOption(RenderLocation.Header, 'Header')
				.addOption(RenderLocation.Sidebar, 'Sidebar')
				.setValue(rule.renderLocation || RenderLocation.Footer) // Default to Footer
				.onChange(async (value: string) => {
					rule.renderLocation = value as RenderLocation;
					this.plugin.normalizeRule(rule);
					await this.plugin.saveSettings();
					this.display();
				}));

		// --- Sidebar-Specific Settings ---
		if (rule.renderLocation === RenderLocation.Sidebar) {
			new Setting(ruleContentContainer)
				.setName('Show in separate tab')
				.setDesc('If enabled, this content will appear in its own sidebar tab instead of being combined with other sidebar rules.')
				.addToggle(toggle => toggle
					.setValue(rule.showInSeparateTab!)
					.onChange(async (value) => {
						rule.showInSeparateTab = value;
						await this.plugin.saveSettings();
						this.display(); // Re-render to show/hide tab name setting
					}));

			if (rule.showInSeparateTab) {
				new Setting(ruleContentContainer)
					.setName('Sidebar tab name')
					.setDesc('The name for the separate sidebar tab. If empty, a default name will be used.')
					.addText(text => text
						.setPlaceholder('e.g., Related Notes')
						.setValue(rule.sidebarTabName || '')
						.onChange((value) => {
							rule.sidebarTabName = value;
							this.debouncedSave();
						}));
			}
		}

		// --- Header-Specific Settings ---
		if (rule.renderLocation === RenderLocation.Header) {
			new Setting(ruleContentContainer)
				.setName('Render above properties')
				.setDesc('If enabled, header content will be rendered above the frontmatter properties section.')
				.addToggle(toggle => toggle
					.setValue(rule.renderAboveProperties || false)
					.onChange(async (value) => {
						rule.renderAboveProperties = value;
						await this.plugin.saveSettings();
					}));
		}

		// --- Footer-Specific Settings ---
		if (rule.renderLocation === RenderLocation.Footer) {
			new Setting(ruleContentContainer)
				.setName('Render above backlinks')
				.setDesc('If enabled, footer content will be rendered above the embedded backlinks section. It is recommended to only enable this if you have backlinks enabled in the note, otherwise the note height may be affected.')
				.addToggle(toggle => toggle
					.setValue(rule.renderAboveBacklinks || false)
					.onChange(async (value) => {
						rule.renderAboveBacklinks = value;
						await this.plugin.saveSettings();
					}));
		}
		
		// --- Popover Visibility Setting ---
		new Setting(ruleContentContainer)
			.setName('Show in popover views')
			.setDesc('If enabled, this rule\'s content will be shown when viewing notes in hover popovers. If disabled, the content will be hidden in popover views.')
			.addToggle(toggle => toggle
				.setValue(rule.showInPopover !== undefined ? rule.showInPopover : true)
				.onChange(async (value) => {
					rule.showInPopover = value;
					await this.plugin.saveSettings();
				}));
		
		// --- Rule Actions: Reorder and Delete ---
		const ruleActionsSetting = new Setting(ruleContentContainer)
			.setClass('virtual-footer-rule-actions');

		// Move Up Button
		ruleActionsSetting.addButton(button => button
			.setIcon('arrow-up')
			.setTooltip('Move rule up')
			.setClass('virtual-footer-move-button')
			.setDisabled(index === 0)
			.onClick(async () => {
				if (index > 0) {
					const rules = this.plugin.settings.rules;
					const ruleToMove = rules.splice(index, 1)[0];
					rules.splice(index - 1, 0, ruleToMove);

					const expandedStateToMove = this.ruleExpandedStates.splice(index, 1)[0];
					this.ruleExpandedStates.splice(index - 1, 0, expandedStateToMove);
					
					await this.plugin.saveSettings();
					this.display();
				}
			}));

		// Move Down Button
		ruleActionsSetting.addButton(button => button
			.setIcon('arrow-down')
			.setTooltip('Move rule down')
			.setClass('virtual-footer-move-button')
			.setDisabled(index === this.plugin.settings.rules.length - 1)
			.onClick(async () => {
				if (index < this.plugin.settings.rules.length - 1) {
					const rules = this.plugin.settings.rules;
					const ruleToMove = rules.splice(index, 1)[0];
					rules.splice(index + 1, 0, ruleToMove);

					const expandedStateToMove = this.ruleExpandedStates.splice(index, 1)[0];
					this.ruleExpandedStates.splice(index + 1, 0, expandedStateToMove);

					await this.plugin.saveSettings();
					this.display();
				}
			}));
		
		// Spacer to push delete button to the right
		ruleActionsSetting.controlEl.createDiv({ cls: 'virtual-footer-actions-spacer' });


		// Delete Rule Button
		ruleActionsSetting.addButton(button => button
			.setButtonText('Delete rule')
			.setWarning() // Style as a warning/destructive action
			.setClass('virtual-footer-delete-button')
			.onClick(async () => {
				// Confirmation could be added here if desired
				this.plugin.settings.rules.splice(index, 1); // Remove rule from array
				this.ruleExpandedStates.splice(index, 1); // Remove corresponding state
				await this.plugin.saveSettings();
				this.display(); // Re-render to reflect deletion and update indices
			}));
	}

	private renderMultiConditionControls(rule: Rule, containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Condition logic')
			.setDesc('Choose whether any condition or all conditions must be met.')
			.addDropdown(dropdown => dropdown
				.addOption('any', 'Any condition')
				.addOption('all', 'All conditions')
				.setValue(rule.multiConditionLogic || 'any')
				.onChange(async (value: 'any' | 'all') => {
					rule.multiConditionLogic = value;
					await this.plugin.saveSettings();
				}));

		const conditionsSetting = new Setting(containerEl)
			.setName('Conditions')
			.setDesc('This rule will apply if the selected logic is met by the following conditions.');

		// Add the hint as a separate paragraph below the description
		const descEl = conditionsSetting.settingEl.querySelector('.setting-item-description');
		if (descEl) {
			const hintEl = document.createElement('p');
			hintEl.className = 'setting-item-description';
			hintEl.innerText = 'Hint: For very complex rules, consider using the Dataview rule type instead.';
			descEl.insertAdjacentElement('afterend', hintEl);
		}

		const conditionsContainer = containerEl.createDiv('virtual-footer-conditions-container');
		rule.conditions?.forEach((condition, index) => {
			this.renderSubConditionControls(condition, index, rule, conditionsContainer);
		});

		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('Add condition')
				.setCta()
				.onClick(async () => {
					rule.conditions = rule.conditions || [];
					rule.conditions.push({ type: 'folder', path: '', recursive: true, negated: false });
					await this.plugin.saveSettings();
					this.display();
				}));
	}

	private renderSubConditionControls(condition: SubCondition, index: number, rule: Rule, containerEl: HTMLElement): void {
		const conditionDiv = containerEl.createDiv('virtual-footer-sub-condition-item');

		const setting = new Setting(conditionDiv)
			.addDropdown(dropdown => dropdown
				.addOption('is', 'is')
				.addOption('not', 'not')
				.setValue(condition.negated ? 'not' : 'is')
				.onChange(async (value: 'is' | 'not') => {
					condition.negated = value === 'not';
					await this.plugin.saveSettings();
				})
			)
			.addDropdown(dropdown => dropdown
				.addOption('folder', 'Folder')
				.addOption('tag', 'Tag')
				.addOption('property', 'Property')
				.setValue(condition.type)
				.onChange(async (value: 'folder' | 'tag' | 'property') => {
					condition.type = value;
					// Reset fields when type changes
					delete condition.path;
					delete condition.recursive;
					delete condition.tag;
					delete condition.includeSubtags;
					delete condition.propertyName;
					delete condition.propertyValue;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (condition.type === 'folder') {
			setting.addText(text => {
				text.setPlaceholder('Folder path')
					.setValue(condition.path || '')
					.onChange((value) => {
						condition.path = value;
						this.debouncedSave();
					});
				new MultiSuggest(text.inputEl, this.getAvailableFolderPaths(), (selected) => {
					condition.path = selected;
					text.setValue(selected);
					this.plugin.saveSettings();
				}, this.plugin.app);
			});
			setting.addToggle(toggle => toggle
				.setTooltip('Include subfolders')
				.setValue(condition.recursive ?? true)
				.onChange(async (value) => {
					condition.recursive = value;
					await this.plugin.saveSettings();
				})
			);
		} else if (condition.type === 'tag') {
			setting.addText(text => {
				text.setPlaceholder('Tag value (no #)')
					.setValue(condition.tag || '')
					.onChange((value) => {
						condition.tag = value.startsWith('#') ? value.substring(1) : value;
						this.debouncedSave();
					});
				new MultiSuggest(text.inputEl, this.getAvailableTags(), (selected) => {
					const normalized = selected.startsWith('#') ? selected.substring(1) : selected;
					condition.tag = normalized;
					text.setValue(normalized);
					this.plugin.saveSettings();
				}, this.plugin.app);
			});
			setting.addToggle(toggle => toggle
				.setTooltip('Include subtags')
				.setValue(condition.includeSubtags ?? false)
				.onChange(async (value) => {
					condition.includeSubtags = value;
					await this.plugin.saveSettings();
				})
			);
		} else if (condition.type === 'property') {
			setting.addText(text => {
				text.setPlaceholder('Property name')
					.setValue(condition.propertyName || '')
					.onChange((value) => {
						condition.propertyName = value;
						this.debouncedSave();
					});
				new MultiSuggest(text.inputEl, this.getAvailablePropertyNames(), (selected) => {
					condition.propertyName = selected;
					text.setValue(selected);
					this.plugin.saveSettings();
				}, this.plugin.app);
			});
			setting.addText(text => text
				.setPlaceholder('Property value (or leave empty)')
				.setValue(condition.propertyValue || '')
				.onChange((value) => {
					condition.propertyValue = value;
					this.debouncedSave();
				})
			);
		}

		setting.addButton(button => button
			.setIcon('trash')
			.setTooltip('Delete condition')
			.setWarning()
			.onClick(async () => {
				rule.conditions?.splice(index, 1);
				await this.plugin.saveSettings();
				this.display();
			})
		);
	}
}
