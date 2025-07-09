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
} from 'obsidian';

// --- Enums ---

/** Defines the type of a rule, determining how it matches files (e.g., by folder, tag, or property). */
enum RuleType {
	Folder = 'folder',
	Tag = 'tag',
	Property = 'property',
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
}

/**
 * Defines the settings structure for the VirtualFooter plugin.
 * Contains an array of rules that dictate content injection.
 */
interface VirtualFooterSettings {
	rules: Rule[];
	/** Whether to refresh the view on file open. Defaults to false. */
	refreshOnFileOpen?: boolean;
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
	}],
	refreshOnFileOpen: false, // Default to false
};

// CSS Classes for styling and identifying plugin-generated elements
const CSS_DYNAMIC_CONTENT_ELEMENT = 'virtual-footer-dynamic-content-element';
const CSS_HEADER_GROUP_ELEMENT = 'virtual-footer-header-group';
const CSS_FOOTER_GROUP_ELEMENT = 'virtual-footer-footer-group';
const CSS_HEADER_RENDERED_CONTENT = 'virtual-footer-header-rendered-content';
const CSS_FOOTER_RENDERED_CONTENT = 'virtual-footer-footer-rendered-content';
const CSS_VIRTUAL_FOOTER_CM_PADDING = 'virtual-footer-cm-padding'; // For CodeMirror live preview footer spacing
const CSS_VIRTUAL_FOOTER_REMOVE_FLEX = 'virtual-footer-remove-flex'; // For CodeMirror live preview footer layout

// DOM Selectors for targeting elements in Obsidian's interface
const SELECTOR_EDITOR_CONTENT_AREA = '.cm-editor .cm-content';
const SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT = '.markdown-source-view.mod-cm6 .cm-contentContainer';
const SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER = '.cm-contentContainer';
const SELECTOR_EDITOR_SIZER = '.cm-sizer'; // Target for live preview footer injection
const SELECTOR_PREVIEW_HEADER_AREA = '.mod-header.mod-ui'; // Target for reading mode header injection
const SELECTOR_PREVIEW_FOOTER_AREA = '.mod-footer'; // Target for reading mode footer injection

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
	private pendingPreviewInjections: WeakMap<MarkdownView, { headerDiv?: HTMLElementWithComponent, footerDiv?: HTMLElementWithComponent, filePath?: string }> = new WeakMap();
	/** Manages MutationObservers for views in preview mode to detect when injection targets are ready. */
	private previewObservers: WeakMap<MarkdownView, MutationObserver> = new WeakMap();
	private initialLayoutReadyProcessed = false;
	private lastSidebarContent: { content: string, sourcePath: string } | null = null;
	private lastSeparateTabContents: Map<string, { content: string, sourcePath: string }> = new Map();

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

		await this.removeDynamicContentFromView(view); // Clear existing content first
		const applicableRulesWithContent = await this._getApplicableRulesAndContent(view.file.path);

		const viewState = view.getState();
		let combinedHeaderText = "";
		let combinedFooterText = "";
		let combinedSidebarText = "";
		let hasFooterRule = false;
		const contentSeparator = "\n\n"; // Separator between content from multiple rules
		this.lastSeparateTabContents.clear();

		// Combine content from all applicable rules
		for (const { rule, contentText, index } of applicableRulesWithContent) {
			if (!contentText || contentText.trim() === "") continue; // Skip empty content

			if (rule.renderLocation === RenderLocation.Header) {
				combinedHeaderText += (combinedHeaderText ? contentSeparator : "") + contentText;
			} else if (rule.renderLocation === RenderLocation.Footer) {
				combinedFooterText += (combinedFooterText ? contentSeparator : "") + contentText;
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

		// Apply specific styles for Live Preview footers if needed
		if (viewState.mode === 'source' && !viewState.source && hasFooterRule) { // Live Preview mode
			this.applyLivePreviewFooterStyles(view);
		}

		let pendingHeaderDiv: HTMLElementWithComponent | null = null;
		let pendingFooterDiv: HTMLElementWithComponent | null = null;

		// Render and inject content based on view mode
		if (viewState.mode === 'preview' || (viewState.mode === 'source' && !viewState.source)) { // Reading or Live Preview
			if (combinedHeaderText.trim()) {
				const result = await this.renderAndInjectGroupedContent(view, combinedHeaderText, RenderLocation.Header);
				// If in preview mode and injection is deferred, store the element
				if (result && viewState.mode === 'preview') {
					pendingHeaderDiv = result;
				}
			}
			if (combinedFooterText.trim()) {
				const result = await this.renderAndInjectGroupedContent(view, combinedFooterText, RenderLocation.Footer);
				if (result && viewState.mode === 'preview') {
					pendingFooterDiv = result;
				}
			}
		}

		// If any content is pending for preview mode, set up an observer
		if (pendingHeaderDiv || pendingFooterDiv) {
			this.pendingPreviewInjections.set(view, {
				headerDiv: pendingHeaderDiv || undefined,
				footerDiv: pendingFooterDiv || undefined,
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
	 * @returns The rendered HTMLElement if injection is deferred (for preview mode), otherwise null.
	 */
	private async renderAndInjectGroupedContent(
		view: MarkdownView,
		combinedContentText: string,
		renderLocation: RenderLocation
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

		// Create and manage an Obsidian Component for the lifecycle of this content
		const component = new Component();
		component.load();
		groupDiv.component = component;

		// Render Markdown content
		await MarkdownRenderer.render(this.app, combinedContentText, groupDiv, sourcePath, component);

		let injectionSuccessful = false;
		const viewState = view.getState();

		// Inject based on view mode and render location
		if (viewState.mode === 'preview') { // Reading mode
			const previewContentParent = view.previewMode.containerEl;
			const targetParent = previewContentParent.querySelector<HTMLElement>(
				isRenderInHeader ? SELECTOR_PREVIEW_HEADER_AREA : SELECTOR_PREVIEW_FOOTER_AREA
			);
			if (targetParent) {
				// Ensure idempotency: remove any existing content of this type before adding new
				const classToRemove = isRenderInHeader ? CSS_HEADER_GROUP_ELEMENT : CSS_FOOTER_GROUP_ELEMENT;
				targetParent.querySelectorAll(`.${classToRemove}`).forEach(el => {
					const holder = el as HTMLElementWithComponent;
					holder.component?.unload();
					el.remove();
				});
				targetParent.appendChild(groupDiv);
				injectionSuccessful = true;
			}
		} else if (viewState.mode === 'source' && !viewState.source) { // Live Preview mode
			if (isRenderInHeader) {
				const cmContentContainer = view.containerEl.querySelector<HTMLElement>(SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER);
				if (cmContentContainer?.parentElement) {
					// Ensure idempotency: remove existing header
					cmContentContainer.parentElement.querySelectorAll(`.${CSS_HEADER_GROUP_ELEMENT}`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
					cmContentContainer.parentElement.insertBefore(groupDiv, cmContentContainer);
					injectionSuccessful = true;
				}
			} else { // Footer in Live Preview
				const targetParent = view.containerEl.querySelector<HTMLElement>(SELECTOR_EDITOR_SIZER);
				if (targetParent) {
					// Ensure idempotency: remove existing footer
					targetParent.querySelectorAll(`.${CSS_FOOTER_GROUP_ELEMENT}`).forEach(el => {
						const holder = el as HTMLElementWithComponent;
						holder.component?.unload();
						el.remove();
					});
					targetParent.appendChild(groupDiv);
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
			if (!pending.headerDiv && !pending.footerDiv) {
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
		const hasEnabledTagRule = this.settings.rules.some(r => r.enabled && r.type === RuleType.Tag);
		if (hasEnabledTagRule && fileCache) {
			const allTagsInFileWithHash = getAllTags(fileCache);
			fileTags = allTagsInFileWithHash ? allTagsInFileWithHash.map(tag => tag.substring(1)) : [];
		}

		for (const [index, currentRule] of this.settings.rules.entries()) {
			if (!currentRule.enabled) {
				continue; // Skip disabled rules
			}

			let isMatch = false;
			const ruleRecursive = currentRule.recursive === undefined ? true : currentRule.recursive;

			// --- Match by Folder ---
			if (currentRule.type === RuleType.Folder && currentRule.path !== undefined) {
				if (currentRule.path === "") { // Matches all files
					isMatch = true;
				} else if (currentRule.path === "/") { // Matches root folder
					isMatch = ruleRecursive ? true : (file.parent?.isRoot() ?? false);
				} else {
					let normalizedRuleFolderPath = currentRule.path.endsWith('/') ? currentRule.path.slice(0, -1) : currentRule.path;
					if (ruleRecursive) {
						isMatch = file.path.startsWith(normalizedRuleFolderPath + '/');
					} else {
						isMatch = file.parent?.path === normalizedRuleFolderPath;
					}
				}
			// --- Match by Tag ---
			} else if (currentRule.type === RuleType.Tag && currentRule.tag && fileTags) {
				const ruleTag = currentRule.tag;
				const includeSubtags = currentRule.includeSubtags ?? false;
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
			// --- Match by Property ---
			} else if (currentRule.type === RuleType.Property && currentRule.propertyName && fileCache?.frontmatter) {
				const propertyKey = currentRule.propertyName;
				const expectedPropertyValue = currentRule.propertyValue;
				const actualPropertyValue = fileCache.frontmatter[propertyKey];

				if (actualPropertyValue !== undefined && actualPropertyValue !== null) {
					if (typeof actualPropertyValue === 'string') {
						isMatch = actualPropertyValue === expectedPropertyValue;
					} else if (Array.isArray(actualPropertyValue)) {
						// For arrays, check if the expected value is one of the items
						isMatch = actualPropertyValue.map(String).includes(expectedPropertyValue!);
					} else if (typeof actualPropertyValue === 'number' || typeof actualPropertyValue === 'boolean') {
						isMatch = String(actualPropertyValue) === expectedPropertyValue;
					}
				}
			}

			if (isMatch) {
				const contentText = await this._fetchContentForRule(currentRule);
				allApplicable.push({ rule: currentRule, contentText, index });
			}
		}
		return allApplicable;
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
			// If loadedData.refreshOnFileOpen is undefined, this.settings.refreshOnFileOpen
			// will retain the value from DEFAULT_SETTINGS due to the initial deep copy.
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
		// Ensure refreshOnFileOpen is definitely a boolean (it should be by now)
		if (typeof this.settings.refreshOnFileOpen !== 'boolean') {
			this.settings.refreshOnFileOpen = DEFAULT_SETTINGS.refreshOnFileOpen!;
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
		}

		// Populate content source-specific fields
		if (migratedRule.contentSource === ContentSource.File) {
			migratedRule.footerFilePath = loadedRule.footerFilePath || ''; // Retain name for compatibility
		}
		return migratedRule; // Normalization will happen after migration
	}

	/**
	 * Normalizes a rule object, ensuring all required fields are present and defaults are applied.
	 * Also cleans up fields that are not relevant to the rule's current type or content source.
	 * @param rule The rule to normalize.
	 */
	public normalizeRule(rule: Rule): void {
		// Ensure basic fields have default values
		rule.name = rule.name === undefined ? DEFAULT_SETTINGS.rules[0].name : rule.name;
		rule.enabled = typeof rule.enabled === 'boolean' ? rule.enabled : DEFAULT_SETTINGS.rules[0].enabled!;
		rule.type = rule.type || DEFAULT_SETTINGS.rules[0].type;

		// Normalize based on RuleType
		if (rule.type === RuleType.Folder) {
			rule.path = rule.path === undefined ? (DEFAULT_SETTINGS.rules[0].path || '') : rule.path;
			// 'recursive' is always true if path is "" (all files)
			rule.recursive = rule.path === "" ? true : (typeof rule.recursive === 'boolean' ? rule.recursive : true);
			// Delete fields not applicable to Folder type
			delete rule.tag;
			delete rule.includeSubtags;
			delete rule.propertyName;
			delete rule.propertyValue;
		} else if (rule.type === RuleType.Tag) {
			rule.tag = rule.tag === undefined ? '' : rule.tag;
			rule.includeSubtags = typeof rule.includeSubtags === 'boolean' ? rule.includeSubtags : false;
			delete rule.path;
			delete rule.recursive;
			delete rule.propertyName;
			delete rule.propertyValue;
		} else if (rule.type === RuleType.Property) {
			rule.propertyName = rule.propertyName === undefined ? '' : rule.propertyName;
			rule.propertyValue = rule.propertyValue === undefined ? '' : rule.propertyValue;
			delete rule.path;
			delete rule.recursive;
			delete rule.tag;
			delete rule.includeSubtags;
		}

		// Normalize content source and related fields
		rule.contentSource = rule.contentSource || DEFAULT_SETTINGS.rules[0].contentSource;
		rule.footerText = rule.footerText || ''; // Retain name for compatibility
		rule.renderLocation = rule.renderLocation || DEFAULT_SETTINGS.rules[0].renderLocation;

		if (rule.contentSource === ContentSource.File) {
			rule.footerFilePath = rule.footerFilePath || ''; // Retain name for compatibility
		} else { // ContentSource.Text
			delete rule.footerFilePath;
		}

		// Normalize sidebar-specific fields
		if (rule.renderLocation === RenderLocation.Sidebar) {
			rule.showInSeparateTab = typeof rule.showInSeparateTab === 'boolean' ? rule.showInSeparateTab : false;
			rule.sidebarTabName = rule.sidebarTabName || '';
		} else {
			delete rule.showInSeparateTab;
			delete rule.sidebarTabName;
		}
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
			.setName('Refresh on focus change')
			.setDesc('If enabled, virtual content will refresh when switching files. This may cause a slight flicker but is useful if you frequently change the text of virtual content and need immediate updates. If disabled the virtual content will be updated on file open and view change (editing/reading view). To prevent virtual content in the sidebar disappearing when clicking out of a note, it will always keep the last notes virtual content open, which means new tabs will show the virtual content of the last used note. Disabled by default.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.refreshOnFileOpen!) // Value is ensured by loadSettings
				.onChange(async (value) => {
					this.plugin.settings.refreshOnFileOpen = value;
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
				.onChange(async (value) => {
					rule.name = value;
					// Update heading text dynamically
					const newNameDisplay = (value && value.trim() !== '') ? value : 'Unnamed Rule';
					ruleHeading.textContent = `Rule ${index + 1}: ${newNameDisplay}`;
					await this.plugin.saveSettings();
				}));

		// --- Enabled/Disabled Toggle ---
		new Setting(ruleContentContainer)
			.setName('Enabled')
			.setDesc('If disabled, this rule will not be applied.')
			.addToggle(toggle => toggle
				.setValue(rule.enabled!) // normalizeRule ensures 'enabled' is boolean
				.onChange(async (value) => {
					rule.enabled = value;
					await this.plugin.saveSettings();
				}));

		// --- Rule Type Setting ---
		new Setting(ruleContentContainer)
			.setName('Rule type')
			.setDesc('Apply this rule based on folder, tag, or property.')
			.addDropdown(dropdown => dropdown
				.addOption(RuleType.Folder, 'Folder')
				.addOption(RuleType.Tag, 'Tag')
				.addOption(RuleType.Property, 'Property')
				.setValue(rule.type)
				.onChange(async (value: string) => {
					rule.type = value as RuleType;
					this.plugin.normalizeRule(rule); // Re-normalize for type-specific fields
					await this.plugin.saveSettings();
					this.display(); // Re-render to show/hide type-specific settings
				}));

		// --- Type-Specific Settings ---
		if (rule.type === RuleType.Folder) {
			new Setting(ruleContentContainer)
				.setName('Folder path')
				.setDesc('Path for the rule. Use "" for all files, "/" for root folder, or "FolderName/" for specific folders (ensure trailing slash for non-root folders).')
				.addText(text => {
					text.setPlaceholder('e.g., Meetings/, /, or empty for all')
						.setValue(rule.path || '')
						.onChange(async (value) => {
							rule.path = value;
							this.plugin.normalizeRule(rule); // Normalize path and recursive flag
							await this.plugin.saveSettings();
							this.display(); // Re-render to update recursive toggle state if needed
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
				.setName('Tag value')
				.setDesc('Tag to match (without the # prefix). E.g., "project" or "status/done".')
				.addText(text => {
					text.setPlaceholder('e.g., important or project/alpha')
						.setValue(rule.tag || '')
						.onChange(async (value) => {
							// Ensure tag doesn't start with '#'
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
				.setName('Property name')
				.setDesc('The name of the Obsidian property (frontmatter key) to match.')
				.addText(text => {
					text.setPlaceholder('e.g., status, type, author')
						.setValue(rule.propertyName || '')
						.onChange(async (value) => {
							rule.propertyName = value;
							await this.plugin.saveSettings();
						});
					new MultiSuggest(text.inputEl, this.getAvailablePropertyNames(), (selectedName) => {
						rule.propertyName = selectedName;
						text.setValue(selectedName);
						this.plugin.saveSettings();
					}, this.plugin.app);
				});

			new Setting(ruleContentContainer)
				.setName('Property value')
				.setDesc('The value the property should have. For list/array properties, matches if this value is one of the items.')
				.addText(text => text
					.setPlaceholder('e.g., complete, article, John Doe')
					.setValue(rule.propertyValue || '')
					.onChange(async (value) => {
						rule.propertyValue = value;
						await this.plugin.saveSettings();
					}));
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
		} else { // ContentSource.Text
			new Setting(ruleContentContainer)
				.setName('Content text')
				.setDesc('Markdown text to display. This will be rendered.')
				.addTextArea(text => text
					.setPlaceholder('Enter your markdown content here...\nSupports multiple lines and **Markdown** formatting.')
					.setValue(rule.footerText || '') // Retained name for compatibility
					.onChange(async (value) => {
						rule.footerText = value;
						await this.plugin.saveSettings();
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
						.onChange(async (value) => {
							rule.sidebarTabName = value;
							await this.plugin.saveSettings();
						}));
			}
		}
		
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
}
