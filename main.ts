import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	Modal,
	ButtonComponent,
	MarkdownView,
	MarkdownRenderer,
	AbstractInputSuggest,
	Component,
	TFile,
	getAllTags,
	ItemView,
	WorkspaceLeaf,
	SettingDefinitionItem,
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
	SectionHeader = 'section-header',
}

type SectionHeaderPlacement = 'top' | 'bottom';

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
	/** For 'section-header' location: the heading text to target. */
	sectionHeaderText?: string;
	/** For 'section-header' location: the heading level to target, e.g. h2. */
	sectionHeaderLevel?: string;
	/** For 'section-header' location: whether to render at the top or bottom of the section. */
	sectionHeaderPlacement?: SectionHeaderPlacement;
	/** Whether to show this rule's content in popover views. */
	showInPopover?: boolean;
	/** Whether to show this rule's content in embedded notes. */
	showInEmbed?: boolean;
	/** Whether to show this rule's content in canvas card previews. */
	showInCanvas?: boolean;
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
	/** Whether to enable virtual content inside embedded notes. */
	enableEmbedRendering?: boolean;
	/** Whether to enable canvas rendering support (can be expensive). */
	enableCanvasRendering?: boolean;
	/** Whether to log embed/canvas resolution details for debugging. */
	debugEmbedCanvas?: boolean;
}

/**
 * Extends HTMLElement to associate an Obsidian Component for lifecycle management.
 * This allows Obsidian to manage resources tied to the DOM element.
 */
interface HTMLElementWithComponent extends HTMLElement {
	/** The Obsidian Component associated with this HTML element. */
	component?: Component;
	/** The MutationObserver for monitoring style changes. */
	observer?: MutationObserver;
}

// --- Constants ---

/** Default settings for the plugin, used when no settings are found or for new rules. */
const DEFAULT_SETTINGS: VirtualFooterSettings = {
	rules: [{
		name: 'Default Rule',
		enabled: true,
		type: RuleType.Folder,
		negated: false,
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
		sectionHeaderText: '',
		sectionHeaderLevel: 'h2',
		sectionHeaderPlacement: 'top',
		showInPopover: true,
		showInEmbed: true,
		showInCanvas: true,
	}],
	refreshOnFileOpen: false, // Default to false
	renderInSourceMode: false, // Default to false
	refreshOnMetadataChange: false, // Default to false
	smartPropertyLinks: false, // Default to false
	enableEmbedRendering: false, // Default to false
	enableCanvasRendering: false, // Default to false
	debugEmbedCanvas: false, // Default to false
};

// CSS Classes for styling and identifying plugin-generated elements
const CSS_DYNAMIC_CONTENT_ELEMENT = 'virtual-footer-dynamic-content-element';
const CSS_HEADER_GROUP_ELEMENT = 'virtual-footer-header-group';
const CSS_FOOTER_GROUP_ELEMENT = 'virtual-footer-footer-group';
const CSS_HEADER_RENDERED_CONTENT = 'virtual-footer-header-rendered-content';
const CSS_FOOTER_RENDERED_CONTENT = 'virtual-footer-footer-rendered-content';
const CSS_SECTION_HEADER_GROUP_ELEMENT = 'virtual-footer-section-header-group';
const CSS_VIRTUAL_FOOTER_CM_PADDING = 'virtual-footer-cm-padding'; // For CodeMirror live preview footer spacing
const CSS_VIRTUAL_FOOTER_REMOVE_FLEX = 'virtual-footer-remove-flex'; // For CodeMirror live preview footer layout
const CSS_ABOVE_BACKLINKS = 'virtual-footer-above-backlinks'; // For removing min-height when above backlinks
const CSS_VIRTUAL_FOOTER_BOTTOM_PADDING_VAR = '--virtual-footer-bottom-padding';
const VIRTUAL_FOOTER_BOTTOM_PADDING_MIN = 200;
const VIRTUAL_FOOTER_BOTTOM_PADDING_MAX = 700;
const VIRTUAL_FOOTER_BOTTOM_PADDING_RATIO = 0.6;

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

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value !== 0;
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (['true', '1', 'yes', 'on', 'not'].includes(normalized)) return true;
		if (['false', '0', 'no', 'off', 'is', ''].includes(normalized)) return false;
	}
	return fallback;
}

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
	viewContent: HTMLElement | null = null;
	component: Component = new Component();
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
			void MarkdownRenderer.render(this.app, data.content, this.viewContent, data.sourcePath, this.component);
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
	settings: VirtualFooterSettings = DEFAULT_SETTINGS;
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
	private popoverObserver: MutationObserver | null = null;
	private canvasObserver: MutationObserver | null = null;
	private sectionHeaderScrollRefreshTimeout: number | null = null;
	private embedObservers: WeakMap<MarkdownView, MutationObserver> = new WeakMap();
	private embedRefreshTimeouts: WeakMap<MarkdownView, number> = new WeakMap();
	private embedLastScanByView: WeakMap<MarkdownView, { filePath: string; time: number }> = new WeakMap();
	private footerPaddingObservers: WeakMap<MarkdownView, ResizeObserver> = new WeakMap();
	private livePreviewFooterStyleApplied: WeakMap<MarkdownView, boolean> = new WeakMap();
	private canvasRefreshTimeout: number | null = null;
	private canvasRefreshInProgress = false;
	private canvasInteractionHandler: ((event: Event) => void) | null = null;

	private getActiveFileForVirtualContent(): TFile | null {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView) as { file?: unknown } | undefined;
		if (activeView?.file instanceof TFile) {
			return activeView.file;
		}

		const workspaceFile = this.app.workspace.getActiveFile();
		return workspaceFile instanceof TFile ? workspaceFile : null;
	}

	private getActiveDocument(): Document {
		return activeDocument;
	}

	private async processSidebarContentForFilePath(filePath: string): Promise<void> {
		const applicableRulesWithContent = await this._getApplicableRulesAndContent(filePath);
		const contentSeparator = "\n\n";
		let combinedSidebarText = "";
		this.lastSeparateTabContents.clear();

		for (const { rule, contentText, index } of applicableRulesWithContent) {
			if (!contentText || contentText.trim() === "" || rule.renderLocation !== RenderLocation.Sidebar) {
				continue;
			}

			if (rule.showInSeparateTab) {
				const viewId = this.getSeparateViewId(index);
				const existingContent = this.lastSeparateTabContents.get(viewId)?.content || "";
				this.lastSeparateTabContents.set(viewId, {
					content: (existingContent ? existingContent + contentSeparator : "") + contentText,
					sourcePath: filePath
				});
			} else {
				combinedSidebarText += (combinedSidebarText ? contentSeparator : "") + contentText;
			}
		}

		this.lastSidebarContent = { content: combinedSidebarText, sourcePath: filePath };
		this.updateAllSidebarViews();
	}

	private async processNonMarkdownActiveFile(): Promise<void> {
		const activeFile = this.getActiveFileForVirtualContent();
		if (!activeFile) {
			if (!this.settings.refreshOnFileOpen || this.app.workspace.getLeavesOfType('markdown').length === 0) {
				this.lastSidebarContent = null;
				this.lastSeparateTabContents.clear();
				this.updateAllSidebarViews();
			}
			return;
		}

		await this.processSidebarContentForFilePath(activeFile.path);
	}

	private logEmbedCanvasDebug(message: string, data?: Record<string, unknown>): void {
		if (!this.settings.debugEmbedCanvas) {
			return;
		}
		if (data) {
			console.debug(`VirtualContent: ${message}`, data);
		} else {
			console.debug(`VirtualContent: ${message}`);
		}
	}

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
			void this.activateView(VIRTUAL_CONTENT_VIEW_TYPE);
		});

		this.addCommand({
			id: 'open-virtual-content-sidebar',
			name: 'Open in sidebar',
			callback: () => {
				void this.activateView(VIRTUAL_CONTENT_VIEW_TYPE);
			},
		});

		this.addCommand({
			id: 'open-all-virtual-content-sidebar-tabs',
			name: 'Open all sidebar tabs',
			callback: () => {
				void this.activateAllSidebarViews();
			},
		});

		const activeDocument = this.getActiveDocument();

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
		this.registerDomEvent(activeDocument, 'mouseover', (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			// Check if the target is a link that could trigger a popover
			if (target.matches('a.internal-link, .internal-link a, [data-href]')) {
				// Store the last hovered link for popover file path extraction
				this.lastHoveredLink = target;
				// Delay to allow popover to be created
				window.setTimeout(() => { void this.processPopoverViews(); }, 100);
			}
		});

		const handleSectionCollapseClick = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			const collapseIndicator = target.closest('.heading-collapse-indicator, .cm-fold-indicator, .collapse-indicator');
			const sectionHeaderTarget = collapseIndicator ? this.getConfiguredSectionHeaderCollapseTarget(collapseIndicator) : null;
			if (
				collapseIndicator?.closest('.markdown-preview-view') &&
				sectionHeaderTarget
			) {
				window.setTimeout(() => {
					const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (activeView) {
						void this.refreshSectionHeaderContent(activeView, true, sectionHeaderTarget);
					}
				}, 150);
			}
		};
		activeDocument.addEventListener('click', handleSectionCollapseClick, true);
		this.register(() => activeDocument.removeEventListener('click', handleSectionCollapseClick, true));

		this.registerDomEvent(activeDocument, 'scroll', (event: Event) => {
			const target = event.target as HTMLElement;
			if (!target.closest?.('.markdown-preview-view')) {
				return;
			}
			if (this.sectionHeaderScrollRefreshTimeout !== null) {
				window.clearTimeout(this.sectionHeaderScrollRefreshTimeout);
			}
			this.sectionHeaderScrollRefreshTimeout = window.setTimeout(() => {
				this.sectionHeaderScrollRefreshTimeout = null;
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					void this.refreshSectionHeaderContent(activeView, false);
				}
			}, 250);
		}, true);

		// Listen for clicks to detect when popovers might switch to editing mode
		this.registerDomEvent(activeDocument, 'click', (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			// Check if the click is within a popover
			const popover = target.closest('.popover.hover-popover');
			if (popover) {
				//console.log("VirtualContent: Click detected in popover, checking for mode change");
				// Delay to allow any mode changes to complete
				window.setTimeout(() => { void this.processPopoverViews(); }, 150);
			}
		});

		// Also listen for DOM mutations to catch dynamically created popovers
		this.popoverObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (mutation.type === 'childList') {
					mutation.addedNodes.forEach(node => {
						if (node.instanceOf(HTMLElement)) {
							// Check if a popover was added
							if (node.classList.contains('popover') && node.classList.contains('hover-popover')) {
								//console.log("VirtualContent: Popover created, processing views");
								// Small delay to ensure the popover content is fully loaded
								window.setTimeout(() => { void this.processPopoverViews(); }, 50);
							}
							// Also check for popovers added within other elements
							const popovers = node.querySelectorAll('.popover.hover-popover');
							if (popovers.length > 0) {
								//console.log("VirtualContent: Popover(s) found in added content, processing views");
								window.setTimeout(() => { void this.processPopoverViews(); }, 50);
							}
						}
					});
				}
				// Listen for attribute changes that might indicate mode switching in popovers
				if (mutation.type === 'attributes' && mutation.target.instanceOf(HTMLElement)) {
					const target = mutation.target;
					// Check if this is a popover that gained or lost the is-editing class
					if (target.classList.contains('popover') && target.classList.contains('hover-popover')) {
						if (mutation.attributeName === 'class') {
							//console.log(`VirtualContent: Popover mode changed, is-editing: ${target.classList.contains('is-editing')}`);
							//setTimeout(() => {this.processPopoverViews();}, 100); // Slightly longer delay for mode changes
						}
					}
				}
			}
		});

		// Observe the entire document for popover creation
		if (this.popoverObserver) {
			this.popoverObserver.observe(activeDocument.body, {
				childList: true,
				subtree: true
			});
		}

		if (this.settings.enableCanvasRendering) {
			// Observe the document for canvas node updates
			this.canvasObserver = new MutationObserver((mutations) => {
				for (const mutation of mutations) {
					if (mutation.type === 'childList') {
						const addedOrRemovedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
						const hasCanvasNodeChange = addedOrRemovedNodes.some((node) => {
							return node.instanceOf(HTMLElement) && (node.classList.contains('canvas-node') || node.querySelector('.canvas-node'));
						});
						if (hasCanvasNodeChange) {
							this.queueCanvasEmbedRefresh();
						}
					}
					if (mutation.type === 'attributes' && mutation.target.instanceOf(HTMLElement)) {
						const target = mutation.target;
						if (target.classList.contains('canvas-node')) {
							this.queueCanvasEmbedRefresh();
						}
					}
				}
			});

			if (this.canvasObserver) {
				this.canvasObserver.observe(activeDocument.body, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: ['class', 'data-path', 'data-href', 'data-src', 'src']
				});
			}

			this.canvasInteractionHandler = (event: Event) => {
				const target = event.target as HTMLElement | null;
				if (target?.closest?.('.canvas')) {
					this.queueCanvasEmbedRefresh();
				}
			};
			this.registerDomEvent(activeDocument, 'wheel', this.canvasInteractionHandler, true);
			this.registerDomEvent(activeDocument, 'pointerup', this.canvasInteractionHandler, true);
		}

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
	onunload() {
		this.popoverObserver?.disconnect();
		this.canvasObserver?.disconnect();
		this.clearAllViewsDynamicContent();

		// Clean up any remaining DOM elements and components directly
		const activeDocument = this.getActiveDocument();
		activeDocument.querySelectorAll(`.${CSS_DYNAMIC_CONTENT_ELEMENT}`).forEach(el => {
			const componentHolder = el as HTMLElementWithComponent;
			if (componentHolder.component) {
				componentHolder.component.unload();
			}
			el.remove();
		});

		// Remove custom CSS classes applied for styling
		activeDocument.querySelectorAll(`.${CSS_VIRTUAL_FOOTER_CM_PADDING}`).forEach(el => el.classList.remove(CSS_VIRTUAL_FOOTER_CM_PADDING));
		activeDocument.querySelectorAll(`.${CSS_VIRTUAL_FOOTER_REMOVE_FLEX}`).forEach(el => el.classList.remove(CSS_VIRTUAL_FOOTER_REMOVE_FLEX));

		// WeakMaps will be garbage collected, but explicit clearing is good practice if needed.
		// Observers and pending injections are cleared per-view in `removeDynamicContentFromView`.
		this.previewObservers = new WeakMap();
		this.pendingPreviewInjections = new WeakMap();
		this.embedObservers = new WeakMap();
		this.embedRefreshTimeouts = new WeakMap();
		if (this.canvasRefreshTimeout !== null) {
			window.clearTimeout(this.canvasRefreshTimeout);
		}
		this.canvasRefreshTimeout = null;
		this.canvasRefreshInProgress = false;
		this.canvasInteractionHandler = null;
	}

	/**
	 * Handles changes to the active Markdown view, triggering content processing.
	 */
	private handleActiveViewChange = () => {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.file) {
			void this._processView(activeView);
			return;
		}
		void this.processNonMarkdownActiveFile();
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
				// console.log("VirtualContent: Found markdown-embed, checking for parent popover");
				// If it's a markdown-embed, check if it's inside a popover
				let parent = element.parentElement;
				while (parent) {
					if (parent.classList.contains('popover') && parent.classList.contains('hover-popover')) {
						// console.log("VirtualContent: Found popover via markdown-embed parent");
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
		const activeDocument = this.getActiveDocument();
		const popovers = activeDocument.querySelectorAll('.popover.hover-popover');
		
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

	private queueEmbedRefresh(view: MarkdownView): void {
		if (!this.settings.enableEmbedRendering) {
			return;
		}
		const existingTimeout = this.embedRefreshTimeouts.get(view);
		if (existingTimeout) {
			window.clearTimeout(existingTimeout);
		}
		const currentPath = view.file?.path;
		if (currentPath) {
			const lastScan = this.embedLastScanByView.get(view);
			if (lastScan && lastScan.filePath === currentPath && Date.now() - lastScan.time < 750) {
				return;
			}
		}
		const timeout = window.setTimeout(() => {
			this.embedRefreshTimeouts.delete(view);
			void this.processEmbedsInView(view);
		}, 250);
		this.embedRefreshTimeouts.set(view, timeout);
	}

	private queueCanvasEmbedRefresh(): void {
		if (!this.settings.enableCanvasRendering) {
			return;
		}
		if (!this.isCanvasActive()) {
			return;
		}
		if (this.canvasRefreshTimeout !== null) {
			return;
		}
		this.canvasRefreshTimeout = window.setTimeout(() => {
			this.canvasRefreshTimeout = null;
			if (this.canvasRefreshInProgress) {
				return;
			}
			this.canvasRefreshInProgress = true;
			void this.processCanvasEmbeds().then(() => {
				this.canvasRefreshInProgress = false;
			}, () => {
				this.canvasRefreshInProgress = false;
			});
		}, 250);
	}

	private ensureEmbedObserver(view: MarkdownView): void {
		if (!this.settings.enableEmbedRendering) {
			return;
		}
		if (this.embedObservers.has(view)) {
			return;
		}
		const observer = new MutationObserver((_mutations) => {
			this.queueEmbedRefresh(view);
		});
		observer.observe(view.containerEl, { childList: true, subtree: true });
		this.embedObservers.set(view, observer);
	}

	private isEmbedInCanvas(embed: HTMLElement): boolean {
		return !!embed.closest('.canvas, .canvas-node, .canvas-node-container, .canvas-node-content');
	}

	private extractEmbedFilePath(embed: HTMLElement): string | null {
		const canvasNode = embed.closest('.canvas-node');
		if (canvasNode) {
			const canvasPath = this.extractCanvasNodePath(canvasNode as HTMLElement);
			if (canvasPath) {
				this.logEmbedCanvasDebug('Canvas node path resolved', {
					canvasPath
				});
				return canvasPath;
			}
		}

		const embedContainer = embed.closest<HTMLElement>('.markdown-embed');
		const scopedContainer = embedContainer || embed;
		const embedLink = scopedContainer.querySelector<HTMLAnchorElement>('.markdown-embed-link a.internal-link[data-href]');
		const embedLinkHref = embedLink?.dataset?.href;
		const rawCandidates = [
			scopedContainer.getAttribute('data-path'),
			scopedContainer.getAttribute('data-src'),
			scopedContainer.getAttribute('src'),
			scopedContainer.getAttribute('data-href'),
			scopedContainer.dataset?.path,
			scopedContainer.dataset?.src,
			scopedContainer.dataset?.href,
			embedLinkHref,
		];
		const resolved = this.resolveFirstPathCandidate(rawCandidates);
		if (!resolved) {
			this.logEmbedCanvasDebug('Embed candidates not resolved', {
				embedClass: scopedContainer.className,
				candidates: rawCandidates.filter(Boolean)
			});
		}
		return resolved;
	}

	private extractCanvasNodePath(canvasNode: HTMLElement): string | null {
		const rawCandidates = [
			canvasNode.getAttribute('data-path'),
			canvasNode.getAttribute('data-href'),
			canvasNode.getAttribute('data-src'),
			canvasNode.getAttribute('data-file'),
			canvasNode.getAttribute('data-file-path'),
			canvasNode.getAttribute('data-filepath'),
			canvasNode.dataset?.path,
			canvasNode.dataset?.href,
			canvasNode.dataset?.src,
			canvasNode.dataset?.file,
			canvasNode.dataset?.filePath,
			canvasNode.dataset?.filepath,
		];

		const linkCandidate = canvasNode.querySelector<HTMLAnchorElement>('.canvas-node-title a.internal-link[data-href]');
		if (linkCandidate?.dataset?.href) {
			rawCandidates.push(linkCandidate.dataset.href);
		}

		const titleEl = canvasNode.querySelector<HTMLElement>('.canvas-node-title, .canvas-node-header, .canvas-node-label');
		const titleText = titleEl?.textContent?.trim();
		if (titleText) {
			rawCandidates.push(titleText);
		}

		const resolved = this.resolveFirstPathCandidate(rawCandidates);
		if (!resolved) {
			const attrDump: Record<string, string> = {};
			Array.from(canvasNode.attributes).forEach(attr => {
				attrDump[attr.name] = attr.value;
			});
			this.logEmbedCanvasDebug('Canvas node path not resolved', {
				canvasNodeClass: canvasNode.className,
				attributes: attrDump,
				candidates: rawCandidates.filter(Boolean)
			});
		}
		return resolved;
	}

	private extractPathFromElement(element: HTMLElement): string | null {
		const rawCandidates = [
			element.getAttribute('data-path'),
			element.getAttribute('data-href'),
			element.getAttribute('data-src'),
			element.getAttribute('src'),
			element.dataset?.path,
			element.dataset?.href,
			element.dataset?.src,
		];

		return this.resolveFirstPathCandidate(rawCandidates);
	}

	private resolveFirstPathCandidate(rawCandidates: Array<string | null | undefined>): string | null {
		for (const raw of rawCandidates) {
			if (!raw) continue;
			const cleaned = raw.split('#')[0].split('^')[0].trim();
			if (!cleaned) continue;
			const resolved = this.app.metadataCache.getFirstLinkpathDest(cleaned, '');
			if (resolved) {
				return resolved.path;
			}
			const abstractFile = this.app.vault.getAbstractFileByPath(cleaned);
			if (abstractFile instanceof TFile) {
				return abstractFile.path;
			}
		}

		return null;
	}

	private findMetadataContainer(container: HTMLElement): HTMLElement | null {
		return container.querySelector<HTMLElement>(`${SELECTOR_METADATA_CONTAINER}, .cm-obsidian-frontmatter`);
	}

	private async processEmbedContainer(
		container: HTMLElement,
		filePath: string,
		allowRule: (rule: Rule) => boolean,
		context: 'embed' | 'canvas'
	): Promise<void> {
		container.dataset.sourcePath = filePath;
		const applicableRulesWithContent = await this._getApplicableRulesAndContent(filePath);
		const filteredRules = applicableRulesWithContent.filter(({ rule }) => allowRule(rule));
		await this.removeInjectedContentDOM(container);

		if (filteredRules.length === 0) {
			return;
		}

		const headerContentGroups: { normal: string[], aboveProperties: string[] } = { normal: [], aboveProperties: [] };
		const footerContentGroups: { normal: string[] } = { normal: [] };
		const sectionHeaderRules: Array<{ rule: Rule; contentText: string; index: number }> = [];
		const contentSeparator = "\n\n";

		for (const { rule, contentText, index } of filteredRules) {
			if (!contentText || contentText.trim() === "") continue;

			if (rule.renderLocation === RenderLocation.Header) {
				if (rule.renderAboveProperties) {
					headerContentGroups.aboveProperties.push(contentText);
				} else {
					headerContentGroups.normal.push(contentText);
				}
			} else if (rule.renderLocation === RenderLocation.Footer) {
				footerContentGroups.normal.push(contentText);
			} else if (rule.renderLocation === RenderLocation.SectionHeader) {
				sectionHeaderRules.push({ rule, contentText, index });
			}
			// Skip sidebar rules for embeds
		}

		if (headerContentGroups.normal.length > 0) {
			const combinedContent = headerContentGroups.normal.join(contentSeparator);
			await this.injectContentIntoPopoverSection(container, combinedContent, 'header', false, filePath, context);
		}

		if (headerContentGroups.aboveProperties.length > 0) {
			const combinedContent = headerContentGroups.aboveProperties.join(contentSeparator);
			await this.injectContentIntoPopoverSection(container, combinedContent, 'header', true, filePath, context);
		}

		if (footerContentGroups.normal.length > 0) {
			const combinedContent = footerContentGroups.normal.join(contentSeparator);
			await this.injectContentIntoPopoverSection(container, combinedContent, 'footer', false, filePath, context);
		}

		for (const { rule, contentText, index } of sectionHeaderRules) {
			await this.injectContentIntoPopoverSectionHeader(container, contentText, rule, index, filePath);
		}
	}

	private async processEmbedsInView(view: MarkdownView): Promise<void> {
		if (!this.settings.enableEmbedRendering) {
			return;
		}
		const embeds = Array.from(view.containerEl.querySelectorAll<HTMLElement>('.markdown-embed'));
		this.logEmbedCanvasDebug('Embed scan in view', {
			viewPath: view.file?.path,
			embedCount: embeds.length
		});
		for (const embed of embeds) {
			if (embed.closest('.popover.hover-popover')) {
				continue;
			}
			if (this.isEmbedInCanvas(embed)) {
				continue;
			}
			const filePath = this.extractEmbedFilePath(embed);
			if (!filePath) {
				this.logEmbedCanvasDebug('Embed path not resolved', {
					embedClass: embed.className
				});
				continue;
			}
			await this.processEmbedContainer(embed, filePath, (rule) => rule.showInEmbed !== false, 'embed');
		}
		if (view.file?.path) {
			this.embedLastScanByView.set(view, { filePath: view.file.path, time: Date.now() });
		}
	}

	private getCanvasNodes(): HTMLElement[] {
		const activeDocument = this.getActiveDocument();
		const canvasRoot = activeDocument.querySelector('.canvas');
		const scopedNodes = canvasRoot ? Array.from(canvasRoot.querySelectorAll<HTMLElement>('.canvas-node')) : [];
		if (scopedNodes.length > 0) {
			return scopedNodes;
		}
		return Array.from(activeDocument.querySelectorAll<HTMLElement>('.canvas-node'));
	}

	private isCanvasActive(): boolean {
		return !!this.getActiveDocument().querySelector('.workspace-leaf.mod-active .canvas, .workspace-leaf.mod-active .canvas-wrapper');
	}

	private async processCanvasEmbeds(): Promise<void> {
		if (!this.settings.enableCanvasRendering) {
			return;
		}
		if (!this.isCanvasActive()) {
			return;
		}
		const activeDocument = this.getActiveDocument();
		const canvasRoot = activeDocument.querySelector('.canvas');
		if (!canvasRoot) {
			return;
		}
		const canvasNodes = this.getCanvasNodes();
		this.logEmbedCanvasDebug('Canvas embed scan', {
			nodeCount: canvasNodes.length
		});
		if (canvasNodes.length === 0) {
			return;
		}
		for (const node of canvasNodes) {
			const embedContainer = node.querySelector<HTMLElement>('.canvas-node-content.markdown-embed, .canvas-node-content .markdown-embed');
			if (!embedContainer) {
				continue;
			}
			if (node.classList.contains('is-editing') || embedContainer.querySelector('.cm-editor')) {
				await this.removeInjectedContentDOM(embedContainer);
				continue;
			}
			const filePath = this.extractCanvasNodePath(node);
			if (!filePath) {
				await this.removeInjectedContentDOM(embedContainer);
				this.logEmbedCanvasDebug('Canvas embed path not resolved', {
					embedClass: embedContainer.className
				});
				continue;
			}
			this.logEmbedCanvasDebug('Canvas embed resolved', {
				filePath
			});
			await this.processEmbedContainer(embedContainer, filePath, (rule) => rule.showInCanvas !== false, 'canvas');
		}
	}

	/**
	 * Process popover content directly when we can't find the MarkdownView
	 */
	private processPopoverDirectly(popover: HTMLElement): void {
		// console.log("VirtualContent: Processing popover directly");
		
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
			void this.injectContentIntoPopover(popover, cleanPath);
		} else {
			// console.log("VirtualContent: Could not determine file path for popover");
			// // Log the DOM structure for debugging
			// console.log("VirtualContent: Popover DOM structure:", popover.innerHTML.substring(0, 1000));
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
			const sectionHeaderRules: Array<{ rule: Rule; contentText: string; index: number }> = [];
			const contentSeparator = "\n\n";
			
			for (const { rule, contentText, index } of filteredRules) {
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
				} else if (rule.renderLocation === RenderLocation.SectionHeader) {
					sectionHeaderRules.push({ rule, contentText, index });
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

			for (const { rule, contentText, index } of sectionHeaderRules) {
				await this.injectContentIntoPopoverSectionHeader(markdownEmbed as HTMLElement, contentText, rule, index, filePath);
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
		filePath: string,
		context?: 'embed' | 'canvas'
	): Promise<void> {
		const isHeader = location === 'header';
		const cssClass = isHeader ? CSS_HEADER_GROUP_ELEMENT : CSS_FOOTER_GROUP_ELEMENT;
		const specialClass = isHeader ? 'virtual-footer-above-properties' : 'virtual-footer-above-backlinks';
		
		// Create new content container
		const groupDiv = container.createDiv() as HTMLElementWithComponent;
		groupDiv.className = `${CSS_DYNAMIC_CONTENT_ELEMENT} ${cssClass}`;
		groupDiv.dataset.sourcePath = filePath;
		if (special) {
			groupDiv.classList.add(specialClass);
		}
		if (context === 'embed') {
			groupDiv.classList.add('virtual-footer-embedded-content');
		}
		if (context === 'canvas') {
			groupDiv.classList.add('virtual-footer-canvas-content');
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
					targetParent = this.findMetadataContainer(container);
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
						if (!targetParent) {
							targetParent = container.querySelector<HTMLElement>('.markdown-preview-view, .markdown-embed-content');
						}
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

	private async injectContentIntoPopoverSectionHeader(
		container: HTMLElement,
		content: string,
		rule: Rule,
		ruleIndex: number,
		filePath: string
	): Promise<void> {
		if (!content || content.trim() === "" || !rule.sectionHeaderText?.trim()) {
			return;
		}

		const component = new Component();
		component.load();

		const groupDiv = container.createDiv() as HTMLElementWithComponent;
		groupDiv.className = `${CSS_DYNAMIC_CONTENT_ELEMENT} ${CSS_SECTION_HEADER_GROUP_ELEMENT}`;
		this.setSectionHeaderDataset(groupDiv, rule, ruleIndex);
		groupDiv.dataset.sourcePath = filePath;
		groupDiv.component = component;

		try {
			await MarkdownRenderer.render(this.app, content, groupDiv, filePath, component);
			this.attachInternalLinkHandlers(groupDiv, filePath, component);

			const popoverContainer = container.closest('.popover.hover-popover');
			const isEditingMode = popoverContainer?.classList.contains('is-editing') ||
				container.querySelector(SELECTOR_EDITOR_SIZER) !== null;
			const level = this.getSectionHeaderLevelNumber(rule);
			const placement = rule.sectionHeaderPlacement || 'top';
			const target = isEditingMode
				? this.findEditorSectionTarget(container, rule)
				: this.findPreviewSectionTarget(container, rule);

			if (!target) {
				component.unload();
				return;
			}

			this.removeSectionHeaderContent(container, ruleIndex);
			if (this.isHeadingCollapsed(target)) {
				component.unload();
				return;
			}

			if (isEditingMode) {
				if (placement === 'top') {
					target.parentElement?.insertBefore(groupDiv, target.nextSibling);
				} else {
					const endNode = this.getEditorSectionEnd(target, level);
					if (endNode) {
						endNode.parentElement?.insertBefore(groupDiv, endNode);
					} else {
						target.parentElement?.appendChild(groupDiv);
					}
				}
			} else {
				const anchor = target.parentElement || target;
				if (placement === 'top') {
					anchor.parentElement?.insertBefore(groupDiv, anchor.nextSibling);
				} else {
					const endNode = this.getPreviewSectionEnd(target, level);
					if (endNode) {
						endNode.parentElement?.insertBefore(groupDiv, endNode);
					} else {
						anchor.parentElement?.appendChild(groupDiv);
					}
				}
			}
			this.updateSectionHeaderVisibility(container, isEditingMode);
		} catch (error) {
			console.error("VirtualContent: Error rendering section header content for popover:", error);
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

		await this.removeDynamicContentFromView(view, true); // Clear existing content first, preserving section content until its target is found
		this.removeStaleSectionHeaderContent(view);
		const applicableRulesWithContent = await this._getApplicableRulesAndContent(view.file.path);

		// Filter rules based on popover visibility setting
		const filteredRules = applicableRulesWithContent.filter(({ rule }) => {
			if (isPopoverView && rule.showInPopover === false) {
				return false; // Skip this rule in popover views
			}
			return true;
		});

		const viewState = view.getState();
		let combinedSidebarText = "";
		let hasFooterRule = false;
		const contentSeparator = "\n\n"; // Separator between content from multiple rules
		this.lastSeparateTabContents.clear();

		// Combine content from all applicable rules, grouping by render location and positioning
		const headerContentGroups: { normal: string[], aboveProperties: string[] } = { normal: [], aboveProperties: [] };
		const footerContentGroups: { normal: string[], aboveBacklinks: string[] } = { normal: [], aboveBacklinks: [] };
		const sectionHeaderRules: Array<{ rule: Rule; contentText: string; index: number }> = [];
		
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
			} else if (rule.renderLocation === RenderLocation.SectionHeader) {
				sectionHeaderRules.push({ rule, contentText, index });
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

		if (hasFooterRule && (shouldRenderInReading || shouldRenderInLivePreview || shouldRenderInSource)) {
			this.applyFooterBottomPadding(view);
		} else {
			this.removeFooterBottomPadding(view);
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

			for (const { rule, contentText, index } of sectionHeaderRules) {
				await this.renderAndInjectSectionHeaderContent(view, contentText, rule, index, true);
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

		this.ensureEmbedObserver(view);
		await this.processEmbedsInView(view);
		this.queueCanvasEmbedRefresh();
	}

	private normalizeSectionHeaderText(text: string): string {
		return text.replace(/\s+/g, ' ').trim().toLowerCase();
	}

	private getSectionHeaderLevelNumber(rule: Rule): number {
		const match = (rule.sectionHeaderLevel || 'h2').match(/^h([1-6])$/);
		return match ? Number(match[1]) : 2;
	}

	private findPreviewSectionTarget(container: HTMLElement, rule: Rule): HTMLElement | null {
		const targetText = this.normalizeSectionHeaderText(rule.sectionHeaderText || '');
		if (!targetText) return null;

		const selector = rule.sectionHeaderLevel || 'h2';
		const headings = Array.from(container.querySelectorAll<HTMLElement>(selector));
		return headings.find((heading) => this.normalizeSectionHeaderText(heading.textContent || '') === targetText) || null;
	}

	private findEditorSectionTarget(container: HTMLElement, rule: Rule): HTMLElement | null {
		const targetText = this.normalizeSectionHeaderText(rule.sectionHeaderText || '');
		if (!targetText) return null;

		const level = this.getSectionHeaderLevelNumber(rule);
		const headings = Array.from(container.querySelectorAll<HTMLElement>(`.cm-line.HyperMD-header-${level}`));
		return headings.find((heading) => {
			const text = (heading.textContent || '').replace(/^#+\s*/, '');
			return this.normalizeSectionHeaderText(text) === targetText;
		}) || null;
	}

	private getPreviewSectionEnd(heading: HTMLElement, level: number): Node | null {
		let node: Node | null = heading.parentElement?.nextSibling || heading.nextSibling;
		while (node) {
			if (node.instanceOf(HTMLElement)) {
				const nextHeading = node.matches('h1,h2,h3,h4,h5,h6')
					? node
					: node.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6');
				if (nextHeading) {
					const nextLevel = Number(nextHeading.tagName.substring(1));
					if (nextLevel <= level) {
						return node;
					}
				}
			}
			node = node.nextSibling;
		}
		return null;
	}

	private getEditorSectionEnd(headingLine: HTMLElement, level: number): Node | null {
		let node: Node | null = headingLine.nextSibling;
		while (node) {
			if (node.instanceOf(HTMLElement)) {
				for (let currentLevel = 1; currentLevel <= level; currentLevel++) {
					if (node.classList.contains(`HyperMD-header-${currentLevel}`)) {
						return node;
					}
				}
			}
			node = node.nextSibling;
		}
		return null;
	}

	private removeSectionHeaderContent(container: HTMLElement, ruleIndex: number): void {
		container.querySelectorAll(`.${CSS_SECTION_HEADER_GROUP_ELEMENT}[data-rule-index="${ruleIndex}"]`).forEach(el => {
			const holder = el as HTMLElementWithComponent;
			holder.component?.unload();
			el.remove();
		});
	}

	private isHeadingCollapsed(heading: HTMLElement): boolean {
		let element: HTMLElement | null = heading;
		let depth = 0;
		while (element && depth < 4) {
			const className = element.className.toString().toLowerCase();
			if (
				element.getAttribute('aria-expanded') === 'false' ||
				className.includes('is-collapsed') ||
				className.includes('is-folded') ||
				className.includes('folded')
			) {
				return true;
			}
			element = element.parentElement;
			depth++;
		}
		return false;
	}

	private setSectionHeaderDataset(groupDiv: HTMLElement, rule: Rule, ruleIndex: number): void {
		groupDiv.dataset.ruleIndex = String(ruleIndex);
		groupDiv.dataset.sectionHeaderText = rule.sectionHeaderText || '';
		groupDiv.dataset.sectionHeaderLevel = rule.sectionHeaderLevel || 'h2';
		groupDiv.dataset.sectionHeaderPlacement = rule.sectionHeaderPlacement || 'top';
	}

	private removeStaleSectionHeaderContent(view: MarkdownView): void {
		const sourcePath = view.file?.path || '';
		view.containerEl.querySelectorAll<HTMLElement>(`.${CSS_SECTION_HEADER_GROUP_ELEMENT}`).forEach(el => {
			if (el.dataset.sourcePath !== sourcePath) {
				const holder = el as HTMLElementWithComponent;
				holder.component?.unload();
				el.remove();
			}
		});
	}

	private updateSectionHeaderVisibility(container: HTMLElement, isEditingMode: boolean): void {
		container.querySelectorAll<HTMLElement>(`.${CSS_SECTION_HEADER_GROUP_ELEMENT}`).forEach(groupDiv => {
			const rule: Rule = {
				type: RuleType.Folder,
				contentSource: ContentSource.Text,
				footerText: '',
				renderLocation: RenderLocation.SectionHeader,
				sectionHeaderText: groupDiv.dataset.sectionHeaderText || '',
				sectionHeaderLevel: groupDiv.dataset.sectionHeaderLevel || 'h2',
				sectionHeaderPlacement: groupDiv.dataset.sectionHeaderPlacement === 'bottom' ? 'bottom' : 'top',
			};
			const heading = isEditingMode
				? this.findEditorSectionTarget(container, rule)
				: this.findPreviewSectionTarget(container, rule);
			groupDiv.toggleAttribute('hidden', heading ? this.isHeadingCollapsed(heading) : false);
		});
	}

	private isConfiguredSectionHeaderElement(heading: HTMLElement): boolean {
		const headingText = this.normalizeSectionHeaderText(heading.textContent || '');
		if (!headingText) {
			return false;
		}

		const headingLevel = heading.tagName.match(/^H([1-6])$/)
			? heading.tagName.toLowerCase()
			: Array.from(heading.classList)
				.map(className => className.match(/^HyperMD-header-([1-6])$/)?.[1])
				.find(Boolean);
		const normalizedHeadingLevel = headingLevel && headingLevel.length === 1 ? `h${headingLevel}` : headingLevel;

		return this.settings.rules.some(rule =>
			rule.enabled &&
			rule.renderLocation === RenderLocation.SectionHeader &&
			this.normalizeSectionHeaderText(rule.sectionHeaderText || '') === headingText &&
			(rule.sectionHeaderLevel || 'h2') === normalizedHeadingLevel
		);
	}

	private getConfiguredSectionHeaderCollapseTarget(collapseIndicator: Element): { text: string; level: string } | null {
		const previewHeading = collapseIndicator.closest('[class^="el-h"], [class*=" el-h"]')?.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6');
		if (previewHeading && this.isConfiguredSectionHeaderElement(previewHeading)) {
			return {
				text: this.normalizeSectionHeaderText(previewHeading.textContent || ''),
				level: previewHeading.tagName.toLowerCase(),
			};
		}

		const editorHeading = collapseIndicator.closest<HTMLElement>('.cm-line[class*="HyperMD-header-"]');
		if (!editorHeading || !this.isConfiguredSectionHeaderElement(editorHeading)) {
			return null;
		}

		const level = Array.from(editorHeading.classList)
			.map(className => className.match(/^HyperMD-header-([1-6])$/)?.[1])
			.find(Boolean);
		return level ? {
			text: this.normalizeSectionHeaderText(editorHeading.textContent || ''),
			level: `h${level}`,
		} : null;
	}

	private async refreshSectionHeaderContent(
		view: MarkdownView,
		forceReplace: boolean,
		target?: { text: string; level: string }
	): Promise<void> {
		if (!view.file) {
			return;
		}

		this.removeStaleSectionHeaderContent(view);
		const applicableRulesWithContent = await this._getApplicableRulesAndContent(view.file.path);
		for (const { rule, contentText, index } of applicableRulesWithContent) {
			if (rule.renderLocation !== RenderLocation.SectionHeader) {
				continue;
			}
			if (
				target &&
				(
					this.normalizeSectionHeaderText(rule.sectionHeaderText || '') !== target.text ||
					(rule.sectionHeaderLevel || 'h2') !== target.level
				)
			) {
				continue;
			}
			await this.renderAndInjectSectionHeaderContent(view, contentText, rule, index, forceReplace);
		}
	}

	private async renderAndInjectSectionHeaderContent(
		view: MarkdownView,
		contentText: string,
		rule: Rule,
		ruleIndex: number,
		forceReplace: boolean = false
	): Promise<void> {
		if (!contentText || contentText.trim() === "" || !rule.sectionHeaderText?.trim()) {
			return;
		}

		const sourcePath = view.file?.path || '';
		const viewState = view.getState();
		const existingSelector = `.${CSS_SECTION_HEADER_GROUP_ELEMENT}[data-rule-index="${ruleIndex}"][data-source-path="${sourcePath}"]`;
		let container: HTMLElement | null = null;
		let heading: HTMLElement | null = null;

		if (viewState.mode !== 'preview') {
			return;
		}

		container = view.previewMode.containerEl;
		heading = this.findPreviewSectionTarget(container, rule);

		if (!container || !heading) {
			return;
		}

		if (this.isHeadingCollapsed(heading)) {
			this.removeSectionHeaderContent(container, ruleIndex);
			return;
		}

		if (!forceReplace && view.containerEl.querySelector(existingSelector)) {
			return;
		}

		const component = new Component();
		component.load();

		const groupDiv = view.containerEl.createDiv() as HTMLElementWithComponent;
		groupDiv.className = `${CSS_DYNAMIC_CONTENT_ELEMENT} ${CSS_SECTION_HEADER_GROUP_ELEMENT}`;
		this.setSectionHeaderDataset(groupDiv, rule, ruleIndex);
		groupDiv.dataset.sourcePath = sourcePath;
		groupDiv.component = component;

		try {
			await MarkdownRenderer.render(this.app, contentText, groupDiv, sourcePath, component);
		} catch (error) {
			console.error("VirtualFooter: Error rendering section header content:", error);
			component.unload();
			return;
		}

		const placement = rule.sectionHeaderPlacement || 'top';
		const level = this.getSectionHeaderLevelNumber(rule);
		let injected = false;

		if (viewState.mode === 'preview') {
			if (heading) {
				this.removeSectionHeaderContent(container, ruleIndex);
				const anchor = heading.parentElement || heading;
				if (placement === 'top') {
					if (anchor !== heading) {
						anchor.appendChild(groupDiv);
					} else {
						anchor.parentElement?.insertBefore(groupDiv, anchor.nextSibling);
					}
				} else {
					const endNode = this.getPreviewSectionEnd(heading, level);
					if (endNode) {
						const previousElement = endNode.previousSibling?.instanceOf(HTMLElement) ? endNode.previousSibling : null;
						if (previousElement && previousElement !== anchor) {
							previousElement.appendChild(groupDiv);
						} else {
							endNode.parentElement?.insertBefore(groupDiv, endNode);
						}
					} else {
						anchor.parentElement?.appendChild(groupDiv);
					}
				}
				injected = true;
				this.updateSectionHeaderVisibility(container, false);
			}
		}

		if (injected) {
			this.attachInternalLinkHandlers(groupDiv, sourcePath, component);
		} else {
			component.unload();
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
		const groupDiv = view.containerEl.createDiv() as HTMLElementWithComponent;
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
			console.error("VirtualFooter: Error during initial render, will retry after delay:", error);
			
			// Add a placeholder while waiting to retry
			const placeholderEl = groupDiv.createDiv({ cls: "virtual-footer-loading" });
			placeholderEl.createEl("p", { text: "Loading virtual content..." });
			
			// Schedule a retry after a delay to allow other plugins to initialize
			window.setTimeout(() => {
				void (async () => {
					try {
						placeholderEl.remove();
						await MarkdownRenderer.render(this.app, combinedContentText, groupDiv, sourcePath, component);
						this.attachInternalLinkHandlers(groupDiv, sourcePath, component);
					} catch (secondError) {
						console.error("VirtualFooter: Failed to render content after retry:", secondError);
						const errorEl = groupDiv.createDiv({ cls: "virtual-footer-error" });
						errorEl.createEl("p", { text: "Error rendering virtual content. Please reload the page or check the content for errors." });
					}
				})();
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
				console.debug(`VirtualFooter: Deferring injection for ${renderLocation} in preview mode. Target not found yet.`);
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
	private computeFooterBottomPaddingPx(containerHeight: number): number {
		const rawPadding = Math.round(containerHeight * VIRTUAL_FOOTER_BOTTOM_PADDING_RATIO);
		return Math.max(VIRTUAL_FOOTER_BOTTOM_PADDING_MIN, Math.min(VIRTUAL_FOOTER_BOTTOM_PADDING_MAX, rawPadding));
	}

	private applyFooterBottomPadding(view: MarkdownView): void {
		const updatePadding = () => {
			const containerHeight = view.containerEl.clientHeight;
			if (!containerHeight) {
				return;
			}
			const paddingPx = this.computeFooterBottomPaddingPx(containerHeight);
			view.containerEl.style.setProperty(CSS_VIRTUAL_FOOTER_BOTTOM_PADDING_VAR, `${paddingPx}px`);
		};

		updatePadding();
		if (!this.footerPaddingObservers.has(view)) {
			const observer = new ResizeObserver(() => {
				updatePadding();
			});
			observer.observe(view.containerEl);
			this.footerPaddingObservers.set(view, observer);
		}
	}

	private removeFooterBottomPadding(view: MarkdownView): void {
		const observer = this.footerPaddingObservers.get(view);
		if (observer) {
			observer.disconnect();
			this.footerPaddingObservers.delete(view);
		}
		view.containerEl.style.removeProperty(CSS_VIRTUAL_FOOTER_BOTTOM_PADDING_VAR);
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
		this.livePreviewFooterStyleApplied.set(view, true);

		// Keep Live Preview bottom spacing stable even when Obsidian rewrites inline styles.
		if (contentEl) {
			const observedContentEl = contentEl as HTMLDivElement & { observer?: MutationObserver };
			const expectedPadding = 'var(--p-spacing)';
			const enforcePadding = () => {
				const currentPadding = contentEl.style.getPropertyValue('padding-bottom');
				const currentPriority = contentEl.style.getPropertyPriority('padding-bottom');
				if (currentPadding !== expectedPadding || currentPriority !== 'important') {
					contentEl.style.setProperty('padding-bottom', expectedPadding, 'important');
				}
			};

			enforcePadding();
			
			// Watch for style mutations and reapply if needed.
			observedContentEl.observer?.disconnect();
			const observer = new MutationObserver(() => {
				enforcePadding();
			});
			
			observer.observe(contentEl, { attributes: true, attributeFilter: ['style'] });

			// Store observer so it can be disconnected during cleanup.
			observedContentEl.observer = observer;
		}
	}

	/**
	 * Removes CSS classes used for Live Preview footer layout adjustments.
	 * @param viewOrContainer The MarkdownView or a specific HTMLElement container.
	 */
	private removeLivePreviewFooterStyles(viewOrContainer: MarkdownView | HTMLElement): void {
		const container = viewOrContainer instanceof MarkdownView ? viewOrContainer.containerEl : viewOrContainer;
		const contentEl = container.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_AREA);
		const containerEl = container.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT);
		const view = viewOrContainer instanceof MarkdownView ? viewOrContainer : null;
		if (view && !this.livePreviewFooterStyleApplied.get(view)) {
			return;
		}
		contentEl?.classList.remove(CSS_VIRTUAL_FOOTER_CM_PADDING);
		containerEl?.classList.remove(CSS_VIRTUAL_FOOTER_REMOVE_FLEX);

		// Restore native-like bottom spacing instead of clearing it entirely.
		if (contentEl) {
			const observedContentEl = contentEl as HTMLDivElement & { observer?: MutationObserver };
			const containerHeight = container.clientHeight;
			if (containerHeight > 0) {
				contentEl.style.setProperty('padding-bottom', `${this.computeFooterBottomPaddingPx(containerHeight)}px`);
			} else {
				contentEl.style.removeProperty('padding-bottom');
			}
			if (observedContentEl.observer) {
				observedContentEl.observer.disconnect();
				delete observedContentEl.observer;
			}
		}
		if (view) {
			this.livePreviewFooterStyleApplied.delete(view);
		}
	}

	/**
	 * Removes all plugin-injected DOM elements from a given container.
	 * @param containerEl The HTMLElement to search within.
	 */
	private async removeInjectedContentDOM(containerEl: HTMLElement, preserveSectionHeader: boolean = false): Promise<void> {
		containerEl.querySelectorAll(`.${CSS_DYNAMIC_CONTENT_ELEMENT}`).forEach(el => {
			if (preserveSectionHeader && el.classList.contains(CSS_SECTION_HEADER_GROUP_ELEMENT)) {
				return;
			}
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
	private async removeDynamicContentFromView(view: MarkdownView, preserveSectionHeader: boolean = false): Promise<void> {
		this.removeLivePreviewFooterStyles(view);
		this.removeFooterBottomPadding(view);
		await this.removeInjectedContentDOM(view.containerEl, preserveSectionHeader);

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

		// Disconnect embed observer for this view
		const embedObserver = this.embedObservers.get(view);
		if (embedObserver) {
			embedObserver.disconnect();
			this.embedObservers.delete(view);
		}
		const embedRefreshTimeout = this.embedRefreshTimeouts.get(view);
		if (embedRefreshTimeout) {
			window.clearTimeout(embedRefreshTimeout);
			this.embedRefreshTimeouts.delete(view);
		}
	}

	/**
	 * Clears dynamic content from all currently open Markdown views.
	 * Typically used during plugin unload or when global settings change significantly.
	 */
	private clearAllViewsDynamicContent(): void {
		this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
			if (leaf.view instanceof MarkdownView) {
				void this.removeDynamicContentFromView(leaf.view);
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

	private _checkPropertyMatch(frontmatter: Record<string, unknown> | undefined, rule: { propertyName?: string, propertyValue?: string }): boolean {
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
					const checkValue = (val: unknown) => {
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
			const results = await dataviewApi.query(query, file.path);

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
		// If in reading view, do nothing, as the default behavior is fine
		if (container.closest(".markdown-reading-view")) return;

		// Handle left-click on internal links and external file links
		component.registerDomEvent(container, 'click', (event: MouseEvent) => {
			if (event.button !== 0) return; // Only handle left-clicks
			const target = event.target as HTMLElement;
			
			const linkElement = target.closest('a.internal-link') as HTMLAnchorElement;
			if (linkElement) {
				event.preventDefault(); // Prevent default link navigation
				const href = linkElement.dataset.href;
				if (href) {
					const inNewPane = event.ctrlKey || event.metaKey; // Open in new pane if Ctrl/Cmd is pressed
					void this.app.workspace.openLinkText(href, sourcePath, inNewPane);
				}
				return;
			}

			// Handle external file links which don't work natively in Live Preview injected content
			const externalLink = target.closest('a.external-link') as HTMLAnchorElement;
			if (externalLink && externalLink.href.startsWith('file:')) {
				event.preventDefault();
				window.open(externalLink.href);
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
					void this.app.workspace.openLinkText(href, sourcePath, true); // Always open in new pane for middle-click
				}
				return;
			}

			// Handle external file links which don't work natively in Live Preview injected content
			const externalLink = target.closest('a.external-link') as HTMLAnchorElement;
			if (externalLink && externalLink.href.startsWith('file:')) {
				event.preventDefault();
				window.open(externalLink.href);
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
				this.settings.rules = loadedData.rules.map((loadedRule: Record<string, unknown>) =>
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
			// Load the new enableEmbedRendering setting if it exists
			if (typeof loadedData.enableEmbedRendering === 'boolean') {
				this.settings.enableEmbedRendering = loadedData.enableEmbedRendering;
			}
			// Load the new enableCanvasRendering setting if it exists
			if (typeof loadedData.enableCanvasRendering === 'boolean') {
				this.settings.enableCanvasRendering = loadedData.enableCanvasRendering;
			}
			// Load the new debugEmbedCanvas setting if it exists
			if (typeof loadedData.debugEmbedCanvas === 'boolean') {
				this.settings.debugEmbedCanvas = loadedData.debugEmbedCanvas;
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
		if (typeof this.settings.enableEmbedRendering !== 'boolean') {
			this.settings.enableEmbedRendering = DEFAULT_SETTINGS.enableEmbedRendering!;
		}
		if (typeof this.settings.enableCanvasRendering !== 'boolean') {
			this.settings.enableCanvasRendering = DEFAULT_SETTINGS.enableCanvasRendering!;
		}
		if (typeof this.settings.debugEmbedCanvas !== 'boolean') {
			this.settings.debugEmbedCanvas = DEFAULT_SETTINGS.debugEmbedCanvas!;
		}
	}

	/**
	 * Migrates a rule from an older settings format to the current Rule interface.
	 * @param loadedRule The rule object loaded from storage.
	 * @param globalRenderLocation An optional global render location from a very old settings format.
	 * @returns A migrated and normalized Rule object.
	 */
	private _migrateRule(loadedRule: Record<string, unknown>, globalRenderLocation?: RenderLocation): Rule {
		const hasNegated = Object.prototype.hasOwnProperty.call(loadedRule, 'negated');
		const migratedNegated = hasNegated
			? normalizeBoolean(loadedRule.negated, false)
			: (DEFAULT_SETTINGS.rules[0].negated ?? false);

		// Determine rule type, defaulting if ambiguous
		let type: RuleType;
		const ruleTypes = Object.keys(RuleType).map(key => RuleType[key as keyof typeof RuleType]);
		const contentSources = Object.keys(ContentSource).map(key => ContentSource[key as keyof typeof ContentSource]);
		const renderLocations = Object.keys(RenderLocation).map(key => RenderLocation[key as keyof typeof RenderLocation]);
		const loadedType = loadedRule.type;
		if (typeof loadedType === 'string' && ruleTypes.includes(loadedType as RuleType)) {
			type = loadedType as RuleType;
		} else if (typeof loadedRule.folderPath === 'string') { // Legacy field
			type = RuleType.Folder;
		} else {
			type = DEFAULT_SETTINGS.rules[0].type;
		}

		// Determine content source, defaulting if ambiguous
		let contentSource: ContentSource;
		const loadedContentSource = loadedRule.contentSource;
		if (typeof loadedContentSource === 'string' && contentSources.includes(loadedContentSource as ContentSource)) {
			contentSource = loadedContentSource as ContentSource;
		} else {
			// If folderPath existed (legacy) and contentSource is undefined, it was likely Text
			contentSource = (typeof loadedRule.folderPath === 'string' && loadedRule.contentSource === undefined)
				? ContentSource.Text
				: DEFAULT_SETTINGS.rules[0].contentSource;
		}

		const migratedRule: Rule = {
			name: typeof loadedRule.name === 'string' && loadedRule.name ? loadedRule.name : DEFAULT_SETTINGS.rules[0].name,
			enabled: typeof loadedRule.enabled === 'boolean' ? loadedRule.enabled : DEFAULT_SETTINGS.rules[0].enabled,
			type: type,
			negated: migratedNegated,
			contentSource: contentSource,
			footerText: typeof loadedRule.footerText === 'string' ? loadedRule.footerText : '', // Retain name for compatibility
			renderLocation: (typeof loadedRule.renderLocation === 'string' && renderLocations.includes(loadedRule.renderLocation as RenderLocation))
				? loadedRule.renderLocation as RenderLocation
				: globalRenderLocation || DEFAULT_SETTINGS.rules[0].renderLocation,
			recursive: typeof loadedRule.recursive === 'boolean' ? loadedRule.recursive : true,
			showInSeparateTab: typeof loadedRule.showInSeparateTab === 'boolean' ? loadedRule.showInSeparateTab : false,
			sidebarTabName: typeof loadedRule.sidebarTabName === 'string' ? loadedRule.sidebarTabName : '',
			multiConditionLogic: loadedRule.multiConditionLogic === 'all' ? 'all' : 'any',
			renderAboveProperties: typeof loadedRule.renderAboveProperties === 'boolean' ? loadedRule.renderAboveProperties : undefined,
			renderAboveBacklinks: typeof loadedRule.renderAboveBacklinks === 'boolean' ? loadedRule.renderAboveBacklinks : undefined,
			sectionHeaderText: typeof loadedRule.sectionHeaderText === 'string' ? loadedRule.sectionHeaderText : '',
			sectionHeaderLevel: typeof loadedRule.sectionHeaderLevel === 'string' ? loadedRule.sectionHeaderLevel : 'h2',
			sectionHeaderPlacement: loadedRule.sectionHeaderPlacement === 'bottom' ? 'bottom' : 'top',
			dataviewQuery: typeof loadedRule.dataviewQuery === 'string' ? loadedRule.dataviewQuery : '',
			footerFilePath: typeof loadedRule.footerFilePath === 'string' ? loadedRule.footerFilePath : '', // Retained name for compatibility
			showInPopover: typeof loadedRule.showInPopover === 'boolean' ? loadedRule.showInPopover : true,
			showInEmbed: typeof loadedRule.showInEmbed === 'boolean' ? loadedRule.showInEmbed : true,
			showInCanvas: typeof loadedRule.showInCanvas === 'boolean' ? loadedRule.showInCanvas : true,
		};

		// Populate type-specific fields
		if (migratedRule.type === RuleType.Folder) {
			migratedRule.path = typeof loadedRule.path === 'string' ? loadedRule.path :
				(typeof loadedRule.folderPath === 'string' ? loadedRule.folderPath : DEFAULT_SETTINGS.rules[0].path);
		} else if (migratedRule.type === RuleType.Tag) {
			migratedRule.tag = typeof loadedRule.tag === 'string' ? loadedRule.tag : '';
			migratedRule.includeSubtags = typeof loadedRule.includeSubtags === 'boolean' ? loadedRule.includeSubtags : false;
		} else if (migratedRule.type === RuleType.Property) {
			migratedRule.propertyName = typeof loadedRule.propertyName === 'string' ? loadedRule.propertyName : '';
			migratedRule.propertyValue = typeof loadedRule.propertyValue === 'string' ? loadedRule.propertyValue : '';
		} else if (migratedRule.type === RuleType.Multi) {
			migratedRule.conditions = Array.isArray(loadedRule.conditions)
				? loadedRule.conditions.map((condition: Record<string, unknown>) => ({
					type: condition.type as 'folder' | 'tag' | 'property',
					negated: normalizeBoolean(condition.negated, false),
					path: condition.path as string | undefined,
					recursive: condition.recursive as boolean | undefined,
					tag: condition.tag as string | undefined,
					includeSubtags: condition.includeSubtags as boolean | undefined,
					propertyName: condition.propertyName as string | undefined,
					propertyValue: condition.propertyValue as string | undefined,
				}))
				: [];
		}

		// Populate content source-specific fields
		if (migratedRule.contentSource === ContentSource.File) {
			migratedRule.footerFilePath = typeof loadedRule.footerFilePath === 'string' ? loadedRule.footerFilePath : ''; // Retained name for compatibility
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
		rule.negated = normalizeBoolean(originalRule.negated, DEFAULT_SETTINGS.rules[0].negated ?? false);

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
			rule.conditions = Array.isArray(originalRule.conditions)
				? originalRule.conditions.map((condition) => ({
					...condition,
					negated: normalizeBoolean(condition.negated, false),
				}))
				: [];
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
			delete rule.sectionHeaderText;
			delete rule.sectionHeaderLevel;
			delete rule.sectionHeaderPlacement;
		} else if (rule.renderLocation === RenderLocation.Footer) {
			rule.renderAboveBacklinks = typeof originalRule.renderAboveBacklinks === 'boolean' ? originalRule.renderAboveBacklinks : false;
			delete rule.renderAboveProperties;
			delete rule.sectionHeaderText;
			delete rule.sectionHeaderLevel;
			delete rule.sectionHeaderPlacement;
		} else if (rule.renderLocation === RenderLocation.SectionHeader) {
			rule.sectionHeaderText = originalRule.sectionHeaderText || '';
			rule.sectionHeaderLevel = /^h[1-6]$/.test(originalRule.sectionHeaderLevel || '') ? originalRule.sectionHeaderLevel : 'h2';
			rule.sectionHeaderPlacement = originalRule.sectionHeaderPlacement === 'bottom' ? 'bottom' : 'top';
			delete rule.renderAboveProperties;
			delete rule.renderAboveBacklinks;
		} else {
			delete rule.renderAboveProperties;
			delete rule.renderAboveBacklinks;
			delete rule.sectionHeaderText;
			delete rule.sectionHeaderLevel;
			delete rule.sectionHeaderPlacement;
		}

		// Normalize popover visibility setting
		rule.showInPopover = typeof originalRule.showInPopover === 'boolean' ? originalRule.showInPopover : true;
		rule.showInEmbed = typeof originalRule.showInEmbed === 'boolean' ? originalRule.showInEmbed : true;
		rule.showInCanvas = typeof originalRule.showInCanvas === 'boolean' ? originalRule.showInCanvas : true;
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

			await this.app.workspace.revealLeaf(leaf);
		}
	}

	private activateAllSidebarViews() {
		void this.activateView(VIRTUAL_CONTENT_VIEW_TYPE);
		this.settings.rules.forEach((rule, index) => {
			if (rule.enabled && rule.renderLocation === RenderLocation.Sidebar && rule.showInSeparateTab) {
				void this.activateView(this.getSeparateViewId(index));
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

				try {
					this.registerView(
						viewId,
						(leaf) => new VirtualContentView(leaf, this, viewId, tabName, () => this.getSeparateTabContent(viewId))
					);
				} catch {
					// Calling `this.registerView` when the view already exists, the following error occurs.
					// This error doesn't need special handling, but if it is left unhandled, the Settings UI will not update properly.

					// console.error(error) // `Error: Attempting to register an existing view type "virtual-content-separate-view-1"`
				}
			}
		});
	}
}

// --- Settings Tab Class ---

type RuleEditorProviders = {
	getAvailableFolderPaths: () => Set<string>;
	getAvailableTags: () => Set<string>;
	getAvailableMarkdownFilePaths: () => Set<string>;
	getAvailablePropertyNames: () => Set<string>;
};

type RuleEditorOptions = {
	title: string;
	onSave: (rule: Rule) => Promise<void> | void;
	onCancel?: () => void;
	providers: RuleEditorProviders;
};

class RuleEditorModal extends Modal {
	private workingRule: Rule;
	private didSave = false;

	constructor(app: App, private plugin: VirtualFooterPlugin, rule: Rule, private options: RuleEditorOptions) {
		super(app);
		this.workingRule = RuleEditorModal.cloneRule(rule);
		this.setTitle(options.title);
	}

	onOpen(): void {
		this.modalEl.addClass('mod-lg');
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.didSave) {
			this.options.onCancel?.();
		}
	}

	private static cloneRule(rule: Rule): Rule {
		return JSON.parse(JSON.stringify(rule));
	}

	private render(): void {
		this.contentEl.empty();
		this.renderRuleEditor(this.contentEl);
		this.renderButtons(this.contentEl);
	}

	private renderButtons(containerEl: HTMLElement): void {
		const buttonsEl = containerEl.createDiv({ cls: 'modal-button-container' });
		new ButtonComponent(buttonsEl)
			.setButtonText('Save')
			.setCta()
			.onClick(() => void this.handleSave());
		new ButtonComponent(buttonsEl)
			.setButtonText('Cancel')
			.onClick(() => this.close());
	}

	private async handleSave(): Promise<void> {
		this.didSave = true;
		this.plugin.normalizeRule(this.workingRule);
		await this.options.onSave(this.workingRule);
		this.close();
	}

	private renderRuleEditor(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Rule name')
			.setDesc('A descriptive name for this rule.')
			.addText(text => text
				.setPlaceholder('e.g., Project notes footer')
				.setValue(this.workingRule.name || '')
				.onChange((value) => {
					this.workingRule.name = value;
				}));

		new Setting(containerEl)
			.setName('Enabled')
			.setDesc('If disabled, this rule will not be applied.')
			.addToggle(toggle => toggle
				.setValue(this.workingRule.enabled ?? true)
				.onChange((value) => {
					this.workingRule.enabled = value;
				}));

		new Setting(containerEl)
			.setName('Rule type')
			.setDesc('Apply this rule based on folder, tag, property, or a combination.')
			.addDropdown(dropdown => dropdown
				.addOption(RuleType.Folder, 'Folder')
				.addOption(RuleType.Tag, 'Tag')
				.addOption(RuleType.Property, 'Property')
				.addOption(RuleType.Multi, 'Multi-condition')
				.addOption(RuleType.Dataview, 'Dataview')
				.setValue(this.workingRule.type)
				.onChange((value: string) => {
					this.workingRule.type = value as RuleType;
					if (this.workingRule.type === RuleType.Multi && !this.workingRule.conditions) {
						this.workingRule.conditions = [];
					}
					this.plugin.normalizeRule(this.workingRule);
					this.render();
				}));

		this.renderTypeSpecificControls(containerEl);

		new Setting(containerEl)
			.setName('Content source')
			.setDesc('Where to get the content from: direct text input or a separate Markdown file.')
			.addDropdown(dropdown => dropdown
				.addOption(ContentSource.Text, 'Direct text')
				.addOption(ContentSource.File, 'Markdown file')
				.setValue(this.workingRule.contentSource || ContentSource.Text)
				.onChange((value: string) => {
					this.workingRule.contentSource = value as ContentSource;
					this.plugin.normalizeRule(this.workingRule);
					this.render();
				}));

		if (this.workingRule.contentSource === ContentSource.File) {
			new Setting(containerEl)
				.setName('Content file path')
				.setDesc('Path to the .md file to use as content (e.g., "templates/common-footer.md").')
				.addText(text => {
					text.setPlaceholder('e.g., templates/common-footer.md')
						.setValue(this.workingRule.footerFilePath || '')
						.onChange((value) => {
							this.workingRule.footerFilePath = value;
						});
					new MultiSuggest(text.inputEl, this.options.providers.getAvailableMarkdownFilePaths(), (selectedPath) => {
						this.workingRule.footerFilePath = selectedPath;
						text.setValue(selectedPath);
					}, this.plugin.app);
				});
		} else {
			new Setting(containerEl)
				.setName('Content text')
				.setDesc('Markdown text to display. This will be rendered.')
				.addTextArea(text => text
					.setPlaceholder('Enter your markdown content here...')
					.setValue(this.workingRule.footerText || '')
					.onChange((value) => {
						this.workingRule.footerText = value;
					}));
		}

		new Setting(containerEl)
			.setName('Render location')
			.setDesc('Choose whether this rule renders its content in the note header, footer, a selected section, or a dedicated sidebar tab.')
			.addDropdown(dropdown => dropdown
				.addOption(RenderLocation.Footer, 'Footer')
				.addOption(RenderLocation.Header, 'Header')
				.addOption(RenderLocation.SectionHeader, 'Section header')
				.addOption(RenderLocation.Sidebar, 'Sidebar')
				.setValue(this.workingRule.renderLocation || RenderLocation.Footer)
				.onChange((value: string) => {
					this.workingRule.renderLocation = value as RenderLocation;
					this.plugin.normalizeRule(this.workingRule);
					this.render();
				}));

		this.renderLocationSpecificControls(containerEl);

		new Setting(containerEl)
			.setName('Show in popover views')
			.setDesc('If enabled, this rule\'s content will be shown when viewing notes in hover popovers.')
			.addToggle(toggle => toggle
				.setValue(this.workingRule.showInPopover !== undefined ? this.workingRule.showInPopover : true)
				.onChange((value) => {
					this.workingRule.showInPopover = value;
				}));

		new Setting(containerEl)
			.setName('Show in embedded notes')
			.setDesc('If enabled, this rule\'s content will be shown inside embedded notes such as ![[Link]].')
			.addToggle(toggle => toggle
				.setValue(this.workingRule.showInEmbed !== undefined ? this.workingRule.showInEmbed : true)
				.onChange((value) => {
					this.workingRule.showInEmbed = value;
				}));

		new Setting(containerEl)
			.setName('Show in canvas cards')
			.setDesc('If enabled, this rule\'s content will be shown inside note cards on Canvas.')
			.addToggle(toggle => toggle
				.setValue(this.workingRule.showInCanvas !== undefined ? this.workingRule.showInCanvas : true)
				.onChange((value) => {
					this.workingRule.showInCanvas = value;
				}));
	}

	private renderTypeSpecificControls(containerEl: HTMLElement): void {
		if (this.workingRule.type === RuleType.Folder) {
			new Setting(containerEl)
				.setName('Condition')
				.setDesc('Choose whether this condition should be met or not met.')
				.addDropdown(dropdown => dropdown
					.addOption('is', 'is')
					.addOption('not', 'not')
					.setValue(this.workingRule.negated ? 'not' : 'is')
					.onChange((value: string) => {
						this.workingRule.negated = value === 'not';
					}));

			new Setting(containerEl)
				.setName('Folder path')
				.setDesc('Leave empty for all files, "/" for root, or "FolderName/" for a specific folder.')
				.addText(text => {
					text.setPlaceholder('e.g., Meetings/, /, or empty for all')
						.setValue(this.workingRule.path || '')
						.onChange((value) => {
							this.workingRule.path = value;
							this.plugin.normalizeRule(this.workingRule);
							this.render();
						});
					new MultiSuggest(text.inputEl, this.options.providers.getAvailableFolderPaths(), (selectedPath) => {
						this.workingRule.path = selectedPath;
						this.plugin.normalizeRule(this.workingRule);
						text.setValue(selectedPath);
						this.render();
					}, this.plugin.app);
				});

			new Setting(containerEl)
				.setName('Include subfolders (recursive)')
				.setDesc('If enabled, the rule applies to files in subfolders.')
				.addToggle(toggle => {
					toggle.setValue(this.workingRule.recursive ?? true)
						.onChange((value) => {
							this.workingRule.recursive = value;
						});
					if (this.workingRule.path === '') {
						toggle.setDisabled(true);
					}
				});
		} else if (this.workingRule.type === RuleType.Tag) {
			new Setting(containerEl)
				.setName('Condition')
				.setDesc('Choose whether this condition should be met or not met.')
				.addDropdown(dropdown => dropdown
					.addOption('is', 'is')
					.addOption('not', 'not')
					.setValue(this.workingRule.negated ? 'not' : 'is')
					.onChange((value: string) => {
						this.workingRule.negated = value === 'not';
					}));

			new Setting(containerEl)
				.setName('Tag value')
				.setDesc('Tag to match (without the # prefix).')
				.addText(text => {
					text.setPlaceholder('e.g., important or project/alpha')
						.setValue(this.workingRule.tag || '')
						.onChange((value) => {
							this.workingRule.tag = value.startsWith('#') ? value.substring(1) : value;
						});
					new MultiSuggest(text.inputEl, this.options.providers.getAvailableTags(), (selectedTag) => {
						const normalizedTag = selectedTag.startsWith('#') ? selectedTag.substring(1) : selectedTag;
						this.workingRule.tag = normalizedTag;
						text.setValue(normalizedTag);
					}, this.plugin.app);
				});

			new Setting(containerEl)
				.setName('Include subtags')
				.setDesc('If enabled, a rule for "tag" applies to "tag/subtag" values.')
				.addToggle(toggle => toggle
					.setValue(this.workingRule.includeSubtags ?? false)
					.onChange((value) => {
						this.workingRule.includeSubtags = value;
					}));
		} else if (this.workingRule.type === RuleType.Property) {
			new Setting(containerEl)
				.setName('Condition')
				.setDesc('Choose whether this condition should be met or not met.')
				.addDropdown(dropdown => dropdown
					.addOption('is', 'is')
					.addOption('not', 'not')
					.setValue(this.workingRule.negated ? 'not' : 'is')
					.onChange((value: string) => {
						this.workingRule.negated = value === 'not';
					}));

			new Setting(containerEl)
				.setName('Property name')
				.setDesc('The name of the Obsidian property to match.')
				.addText(text => {
					text.setPlaceholder('e.g., status, type, author')
						.setValue(this.workingRule.propertyName || '')
						.onChange((value) => {
							this.workingRule.propertyName = value;
						});
					new MultiSuggest(text.inputEl, this.options.providers.getAvailablePropertyNames(), (selectedName) => {
						this.workingRule.propertyName = selectedName;
						text.setValue(selectedName);
					}, this.plugin.app);
				});

			new Setting(containerEl)
				.setName('Property value')
				.setDesc('Leave empty to match any file that has the property.')
				.addText(text => text
					.setPlaceholder('e.g., complete, article, John Doe')
					.setValue(this.workingRule.propertyValue || '')
					.onChange((value) => {
						this.workingRule.propertyValue = value;
					}));
		} else if (this.workingRule.type === RuleType.Multi) {
			this.renderMultiConditionControls(containerEl);
		} else if (this.workingRule.type === RuleType.Dataview) {
			new Setting(containerEl)
				.setName('Condition')
				.setDesc('Choose whether this condition should be met or not met.')
				.addDropdown(dropdown => dropdown
					.addOption('is', 'is')
					.addOption('not', 'not')
					.setValue(this.workingRule.negated ? 'not' : 'is')
					.onChange((value: string) => {
						this.workingRule.negated = value === 'not';
					}));

			new Setting(containerEl)
				.setName('Dataview query')
				.setDesc('Enter a Dataview LIST query to match notes where this rule should apply.')
				.addTextArea(text => text
					.setPlaceholder('LIST FROM "References/Authors" WHERE startswith(file.name, "Example")')
					.setValue(this.workingRule.dataviewQuery || '')
					.onChange((value) => {
						this.workingRule.dataviewQuery = value;
					}));

			const infoDiv = containerEl.createDiv('dataview-info');
			infoDiv.createEl('p', {
				text: 'Note: The Dataview plugin must be installed for this rule type to work.',
				cls: 'setting-item-description',
			});
		}
	}

	private renderMultiConditionControls(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Condition logic')
			.setDesc('Choose whether any condition or all conditions must be met.')
			.addDropdown(dropdown => dropdown
				.addOption('any', 'Any condition')
				.addOption('all', 'All conditions')
				.setValue(this.workingRule.multiConditionLogic || 'any')
				.onChange((value) => {
					this.workingRule.multiConditionLogic = value as 'any' | 'all';
				}));

		const conditionsContainer = containerEl.createDiv('virtual-footer-conditions-container');
		const conditions = this.workingRule.conditions ?? [];
		conditions.forEach((condition, index) => {
			this.renderSubConditionControls(condition, index, conditionsContainer);
		});

		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('Add condition')
				.setCta()
				.onClick(() => {
					this.workingRule.conditions = this.workingRule.conditions || [];
					this.workingRule.conditions.push({ type: 'folder', path: '', recursive: true, negated: false });
					this.render();
				}));
	}

	private renderSubConditionControls(condition: SubCondition, index: number, containerEl: HTMLElement): void {
		const conditionDiv = containerEl.createDiv('virtual-footer-sub-condition-item');
		const setting = new Setting(conditionDiv)
			.addDropdown(dropdown => dropdown
				.addOption('is', 'is')
				.addOption('not', 'not')
				.setValue(condition.negated ? 'not' : 'is')
				.onChange((value: string) => {
					condition.negated = value === 'not';
				}))
			.addDropdown(dropdown => dropdown
				.addOption('folder', 'Folder')
				.addOption('tag', 'Tag')
				.addOption('property', 'Property')
				.setValue(condition.type)
				.onChange((value: string) => {
					condition.type = value as 'folder' | 'tag' | 'property';
					delete condition.path;
					delete condition.recursive;
					delete condition.tag;
					delete condition.includeSubtags;
					delete condition.propertyName;
					delete condition.propertyValue;
					this.render();
				}));

		if (condition.type === 'folder') {
			setting.addText(text => {
				text.setPlaceholder('Folder path')
					.setValue(condition.path || '')
					.onChange((value) => {
						condition.path = value;
					});
				new MultiSuggest(text.inputEl, this.options.providers.getAvailableFolderPaths(), (selected) => {
					condition.path = selected;
					text.setValue(selected);
				}, this.plugin.app);
			});
			setting.addToggle(toggle => toggle
				.setTooltip('Include subfolders')
				.setValue(condition.recursive ?? true)
				.onChange((value) => {
					condition.recursive = value;
				}));
		} else if (condition.type === 'tag') {
			setting.addText(text => {
				text.setPlaceholder('Tag value (no #)')
					.setValue(condition.tag || '')
					.onChange((value) => {
						condition.tag = value.startsWith('#') ? value.substring(1) : value;
					});
				new MultiSuggest(text.inputEl, this.options.providers.getAvailableTags(), (selected) => {
					const normalized = selected.startsWith('#') ? selected.substring(1) : selected;
					condition.tag = normalized;
					text.setValue(normalized);
				}, this.plugin.app);
			});
			setting.addToggle(toggle => toggle
				.setTooltip('Include subtags')
				.setValue(condition.includeSubtags ?? false)
				.onChange((value) => {
					condition.includeSubtags = value;
				}));
		} else if (condition.type === 'property') {
			setting.addText(text => {
				text.setPlaceholder('Property name')
					.setValue(condition.propertyName || '')
					.onChange((value) => {
						condition.propertyName = value;
					});
				new MultiSuggest(text.inputEl, this.options.providers.getAvailablePropertyNames(), (selected) => {
					condition.propertyName = selected;
					text.setValue(selected);
				}, this.plugin.app);
			});
			setting.addText(text => text
				.setPlaceholder('Property value (optional)')
				.setValue(condition.propertyValue || '')
				.onChange((value) => {
					condition.propertyValue = value;
				}));
		}

		setting.addButton(button => button
			.setIcon('trash')
			.setTooltip('Delete condition')
			.setDestructive()
			.onClick(() => {
				this.workingRule.conditions?.splice(index, 1);
				this.render();
			}));
	}

	private renderLocationSpecificControls(containerEl: HTMLElement): void {
		if (this.workingRule.renderLocation === RenderLocation.Sidebar) {
			new Setting(containerEl)
				.setName('Show in separate tab')
				.setDesc('If enabled, this content appears in its own sidebar tab.')
				.addToggle(toggle => toggle
					.setValue(this.workingRule.showInSeparateTab ?? false)
					.onChange((value) => {
						this.workingRule.showInSeparateTab = value;
						this.render();
					}));

			if (this.workingRule.showInSeparateTab) {
				new Setting(containerEl)
					.setName('Sidebar tab name')
					.setDesc('If empty, a default name is used.')
					.addText(text => text
						.setPlaceholder('e.g., Related notes')
						.setValue(this.workingRule.sidebarTabName || '')
						.onChange((value) => {
							this.workingRule.sidebarTabName = value;
						}));
			}
		}

		if (this.workingRule.renderLocation === RenderLocation.Header) {
			new Setting(containerEl)
				.setName('Render above properties')
				.setDesc('If enabled, header content renders above frontmatter properties.')
				.addToggle(toggle => toggle
					.setValue(this.workingRule.renderAboveProperties || false)
					.onChange((value) => {
						this.workingRule.renderAboveProperties = value;
					}));
		}

		if (this.workingRule.renderLocation === RenderLocation.SectionHeader) {
			new Setting(containerEl)
				.setName('Header text')
				.setDesc('The exact heading text to target, without leading # characters.')
				.addText(text => text
					.setPlaceholder('e.g., Tasks')
					.setValue(this.workingRule.sectionHeaderText || '')
					.onChange((value) => {
						this.workingRule.sectionHeaderText = value;
					}));

			new Setting(containerEl)
				.setName('Header type')
				.setDesc('Choose which heading level should be matched.')
				.addDropdown(dropdown => dropdown
					.addOption('h1', 'H1')
					.addOption('h2', 'H2')
					.addOption('h3', 'H3')
					.addOption('h4', 'H4')
					.addOption('h5', 'H5')
					.addOption('h6', 'H6')
					.setValue(this.workingRule.sectionHeaderLevel || 'h2')
					.onChange((value: string) => {
						this.workingRule.sectionHeaderLevel = value;
					}));

			new Setting(containerEl)
				.setName('Section placement')
				.setDesc('Choose whether content appears at the top or bottom of the section.')
				.addDropdown(dropdown => dropdown
					.addOption('top', 'Top of section')
					.addOption('bottom', 'Bottom of section')
					.setValue(this.workingRule.sectionHeaderPlacement || 'top')
					.onChange((value: string) => {
						this.workingRule.sectionHeaderPlacement = value as SectionHeaderPlacement;
					}));
		}

		if (this.workingRule.renderLocation === RenderLocation.Footer) {
			new Setting(containerEl)
				.setName('Render above backlinks')
				.setDesc('If enabled, footer content renders above embedded backlinks.')
				.addToggle(toggle => toggle
					.setValue(this.workingRule.renderAboveBacklinks || false)
					.onChange((value) => {
						this.workingRule.renderAboveBacklinks = value;
					}));
		}
	}
}

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
	constructor(app: App, private plugin: VirtualFooterPlugin) {
		super(app, plugin);
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

	getSettingDefinitions(): SettingDefinitionItem[] {
		this.clearSuggestionCaches();
		const rules = this.plugin.settings.rules ?? [];
		return [
			{
				name: 'Render in source mode',
				desc: 'If enabled, virtual content will be rendered in source mode. By default, content only appears in Live Preview and Reading modes.',
				control: { type: 'toggle', key: 'renderInSourceMode' },
			},
			{
				name: 'Refresh on focus change',
				desc: 'If enabled, virtual content will refresh when switching files. This can cause a slight flicker but ensures immediate updates.',
				control: { type: 'toggle', key: 'refreshOnFileOpen' },
			},
			{
				name: 'Refresh on metadata change',
				desc: 'If enabled, virtual content will refresh when the current note\'s metadata changes.',
				control: { type: 'toggle', key: 'refreshOnMetadataChange' },
			},
			{
				name: 'Smart property links',
				desc: 'If enabled, property conditions that look like links match against the resolved file.',
				control: { type: 'toggle', key: 'smartPropertyLinks' },
			},
			{
				name: 'Embed rendering',
				desc: 'If enabled, virtual content will render inside embedded notes such as ![[Link]].',
				control: { type: 'toggle', key: 'enableEmbedRendering' },
			},
			{
				name: 'Canvas rendering',
				desc: 'If enabled, virtual content can be rendered inside Canvas note cards. Restart Obsidian after changing this setting.',
				control: { type: 'toggle', key: 'enableCanvasRendering' },
			},
			{
				type: 'list',
				heading: 'Rules',
				emptyState: 'No rules yet.',
				addItem: {
					name: 'Add rule',
					action: () => this.openNewRuleModal(),
				},
				onReorder: (oldIndex: number, newIndex: number) => {
					const rulesList = this.plugin.settings.rules;
					const [moved] = rulesList.splice(oldIndex, 1);
					rulesList.splice(newIndex, 0, moved);
					void this.plugin.saveSettings();
				},
				onDelete: (idx: number) => {
					this.plugin.settings.rules.splice(idx, 1);
					this.plugin.saveSettings();
					void this.refreshSettingsUi();
				},
				items: rules.map((rule, index) => ({
					name: this.getRuleDisplayName(rule, index),
					desc: this.getRuleSummary(rule),
					searchable: false,
					render: (setting: Setting) => {
						setting.addButton(button => button
							.setButtonText('Edit')
							.setCta()
							.onClick(() => this.openEditRuleModal(index)));
						setting.addButton(button => button
							.setButtonText('Duplicate')
							.onClick(() => this.duplicateRule(index)));
					},
				})),
			},
			{
				type: 'group',
				heading: 'Developer',
				items: [
					{
						name: 'Debug embed/canvas rendering',
						desc: 'If enabled, logs embed/canvas path resolution details to the developer console for troubleshooting.',
						control: { type: 'toggle', key: 'debugEmbedCanvas' },
					},
				],
			},
		];
	}

	private clearSuggestionCaches(): void {
		this.allFolderPathsCache = null;
		this.allTagsCache = null;
		this.allMarkdownFilePathsCache = null;
		this.allPropertyNamesCache = null;
	}

	private refreshSettingsUi(): void {
		const updater = (this as unknown as { update?: () => void }).update;
		if (typeof updater === 'function') {
			updater.call(this);
		}
	}

	private createRuleTemplate(): Rule {
		const newRule = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.rules[0]));
		this.plugin.normalizeRule(newRule);
		return newRule;
	}

	private openNewRuleModal(): void {
		const newRule = this.createRuleTemplate();
		this.openRuleModal('Add rule', newRule, async (rule) => {
			this.plugin.settings.rules.push(rule);
			await this.plugin.saveSettings();
			this.refreshSettingsUi();
		});
	}

	private openEditRuleModal(index: number): void {
		const rule = this.plugin.settings.rules[index];
		if (!rule) return;
		this.openRuleModal('Edit rule', rule, async (updatedRule) => {
			this.plugin.settings.rules[index] = updatedRule;
			await this.plugin.saveSettings();
			this.refreshSettingsUi();
		});
	}

	private openRuleModal(title: string, rule: Rule, onSave: (rule: Rule) => Promise<void>): void {
		const modal = new RuleEditorModal(this.app, this.plugin, rule, {
			title,
			onSave,
			providers: {
				getAvailableFolderPaths: () => this.getAvailableFolderPaths(),
				getAvailableTags: () => this.getAvailableTags(),
				getAvailableMarkdownFilePaths: () => this.getAvailableMarkdownFilePaths(),
				getAvailablePropertyNames: () => this.getAvailablePropertyNames(),
			},
		});
		modal.open();
	}

	private duplicateRule(index: number): void {
		const rule = this.plugin.settings.rules[index];
		if (!rule) return;
		const duplicate = JSON.parse(JSON.stringify(rule)) as Rule;
		if (duplicate.name) {
			duplicate.name = `${duplicate.name} copy`;
		}
		this.plugin.normalizeRule(duplicate);
		this.plugin.settings.rules.splice(index + 1, 0, duplicate);
		void this.plugin.saveSettings().then(() => this.refreshSettingsUi()).catch(() => undefined);
	}

	private async moveRule(fromIndex: number, toIndex: number): Promise<void> {
		const rules = this.plugin.settings.rules;
		if (toIndex < 0 || toIndex >= rules.length) return;
		const [moved] = rules.splice(fromIndex, 1);
		rules.splice(toIndex, 0, moved);
		await this.plugin.saveSettings();
		this.refreshSettingsUi();
	}

	private async deleteRule(index: number): Promise<void> {
		this.plugin.settings.rules.splice(index, 1);
		await this.plugin.saveSettings();
		this.refreshSettingsUi();
	}

	private getRuleDisplayName(rule: Rule, index: number): string {
		const name = rule.name?.trim();
		return name ? name : `Rule ${index + 1}`;
	}

	private getRuleSummary(rule: Rule): string {
		const parts: string[] = [];
		if (rule.enabled === false) parts.push('Disabled');
		parts.push(this.getRuleTypeSummary(rule));
		parts.push(this.getRuleContentSummary(rule));
		parts.push(this.getRuleLocationSummary(rule));
		return parts.filter(Boolean).join(' | ');
	}

	private getRuleTypeSummary(rule: Rule): string {
		switch (rule.type) {
			case RuleType.Folder: {
				const path = rule.path?.trim() || 'all files';
				const condition = rule.negated ? 'not in' : 'in';
				const recursive = rule.path === '' ? '' : (rule.recursive ? ' (recursive)' : '');
				return `Folder ${condition} ${path}${recursive}`;
			}
			case RuleType.Tag: {
				const tag = rule.tag?.trim() || 'tag';
				const condition = rule.negated ? 'not tagged' : 'tagged';
				const subtags = rule.includeSubtags ? ' (include subtags)' : '';
				return `Tag ${condition} #${tag}${subtags}`;
			}
			case RuleType.Property: {
				const name = rule.propertyName?.trim() || 'property';
				const condition = rule.negated ? 'not' : 'has';
				const value = rule.propertyValue?.trim() ? ` = ${rule.propertyValue.trim()}` : '';
				return `Property ${condition} ${name}${value}`;
			}
			case RuleType.Multi: {
				const logic = rule.multiConditionLogic === 'all' ? 'all' : 'any';
				const count = rule.conditions?.length ?? 0;
				return `Multi (${logic}, ${count} condition${count === 1 ? '' : 's'})`;
			}
			case RuleType.Dataview: {
				return 'Dataview query';
			}
			default:
				return 'Rule';
		}
	}

	private getRuleContentSummary(rule: Rule): string {
		if (rule.contentSource === ContentSource.File) {
			return rule.footerFilePath?.trim() ? `File: ${rule.footerFilePath.trim()}` : 'File content';
		}
		return 'Text content';
	}

	private getRuleLocationSummary(rule: Rule): string {
		switch (rule.renderLocation) {
			case RenderLocation.Header:
				return 'Header';
			case RenderLocation.Footer:
				return 'Footer';
			case RenderLocation.Sidebar:
				return rule.showInSeparateTab ? 'Sidebar (separate tab)' : 'Sidebar';
			case RenderLocation.SectionHeader:
				return 'Section header';
			default:
				return 'Location';
		}
	}
}
