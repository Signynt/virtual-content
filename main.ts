import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	MarkdownView,
	MarkdownRenderer,
	AbstractInputSuggest,
	Component,
	TFile
} from 'obsidian';

// Interfaces
interface VirtualFooterSettings {
	rules: { folderPath: string; footerText: string }[];
	renderLocation: 'footer' | 'header';
}

interface HTMLElementWithComponent extends HTMLElement {
	component?: Component;
}

// Constants
const DEFAULT_SETTINGS: VirtualFooterSettings = {
	rules: [{ folderPath: '', footerText: '' }],
	renderLocation: 'footer'
};

// --- CSS Classes ---
const CSS_DYNAMIC_CONTENT_ELEMENT = 'dynamic-content-element';
const CSS_HEADER_RENDERED_CONTENT = 'header-rendered-content';
const CSS_FOOTER_RENDERED_CONTENT = 'footer-rendered-content';
const CSS_VIRTUAL_FOOTER_CM_PADDING = 'virtual-footer-cm-padding';
const CSS_VIRTUAL_FOOTER_REMOVE_FLEX = 'virtual-footer-remove-flex';

// --- DOM Selectors ---
const SELECTOR_EDITOR_CONTENT_AREA = '.cm-editor .cm-content';
const SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT = '.markdown-source-view.mod-cm6 .cm-contentContainer'; // Used for styling
const SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER = '.cm-contentContainer'; // Used for header injection target search
const SELECTOR_EDITOR_SIZER = '.cm-sizer'; // Used for Live Preview footer injection
const SELECTOR_PREVIEW_HEADER_AREA = '.mod-header.mod-ui';
const SELECTOR_PREVIEW_FOOTER_AREA = '.mod-footer';

const SELECTORS_POTENTIAL_DYNAMIC_CONTENT_PARENTS = [
	SELECTOR_EDITOR_SIZER,
	SELECTOR_PREVIEW_FOOTER_AREA,
	SELECTOR_PREVIEW_HEADER_AREA,
	'.metadata-container .metadata-content', // Legacy selector for cleanup
	'.view-header'                           // Legacy selector for cleanup
];

export class MultiSuggest extends AbstractInputSuggest<string> {
	content: Set<string>;

	constructor(private inputEl: HTMLInputElement, content: Set<string>, private onSelectCb: (value: string) => void, app: App) {
		super(app, inputEl);
		this.content = content;
	}

	getSuggestions(inputStr: string): string[] {
		const lowerCaseInputStr = inputStr.toLocaleLowerCase();
		return [...this.content].filter((content) =>
			content.toLocaleLowerCase().contains(lowerCaseInputStr)
		);
	}

	renderSuggestion(content: string, el: HTMLElement): void {
		el.setText(content);
	}

	selectSuggestion(content: string, evt: MouseEvent | KeyboardEvent): void {
		this.onSelectCb(content);
		this.inputEl.value = content;
		this.inputEl.blur()
		this.close();
	}
}

/**
 * Main plugin class for VirtualFooter.
 * This plugin allows users to define custom footer (or header) content
 * that is dynamically injected into Markdown views based on folder-specific rules.
 */
export default class VirtualFooterPlugin extends Plugin {
	/**
	 * Stores the plugin's settings, loaded from and saved to Obsidian's data storage.
	 * Contains rules for matching folders to footer text and other display preferences.
	 */
	settings: VirtualFooterSettings;

	/**
	 * Called when the plugin is first loaded.
	 * Initializes the plugin by loading settings, adding a settings tab,
	 * and registering event listeners for file opening and layout changes
	 * to dynamically update views with virtual footers/headers.
	 */
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new VirtualFooterSettingTab(this.app, this));

		// Register event listeners to update views when files are opened or layout changes
		this.registerEvent(
			this.app.workspace.on('file-open', () => this.handleActiveViewChange())
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', () => this.handleActiveViewChange())
		);
		this.handleActiveViewChange(); // Initial call to process any already open files
	}

	/**
	 * Called when the plugin is unloaded.
	 * Performs cleanup tasks, including removing all injected content and styles
	 * from all Markdown views and cleaning up any globally applied CSS classes
	 * or dynamically created elements.
	 */
	async onunload() {
		this.clearAllViews(); // Clean up all individual views

		// Global cleanup for any elements potentially missed by view-specific cleanup
		// This targets dynamically created content elements.
		document.querySelectorAll(`.${CSS_DYNAMIC_CONTENT_ELEMENT}`).forEach(el => {
			const componentHolder = el as HTMLElementWithComponent;
			if (componentHolder.component) {
				componentHolder.component.unload(); // Unload associated Obsidian component
			}
			el.remove(); // Remove the element from the DOM
		});

		// Remove global CSS classes applied for styling
		document.querySelectorAll(`.${CSS_VIRTUAL_FOOTER_CM_PADDING}`).forEach(el => el.classList.remove(CSS_VIRTUAL_FOOTER_CM_PADDING));
		document.querySelectorAll(`.${CSS_VIRTUAL_FOOTER_REMOVE_FLEX}`).forEach(el => el.classList.remove(CSS_VIRTUAL_FOOTER_REMOVE_FLEX));
	}

	// --- Core View Handling ---

	/**
	 * Handles changes in the active view (e.g., opening a new file, switching tabs).
	 * It identifies the active Markdown view and triggers processing for it.
	 */
	handleActiveViewChange() {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		this._processView(activeView);
	}

	/**
	 * Processes a given Markdown view to apply or remove virtual footer/header content.
	 * If the view is invalid or has no file, it clears all views.
	 * Otherwise, it cleans up existing content/styles from the view,
	 * applies specific styles for Live Preview footer mode if applicable,
	 * and then renders and injects new content if the view is in Preview or Live Preview editor mode.
	 * @param view The MarkdownView to process, or null if no Markdown view is active.
	 */
	private async _processView(view: MarkdownView | null) {
		if (!view || !view.file) {
			this.clearAllViews(); // If no valid view, clear everything
			return;
		}

		// Always clean up the current view before applying new content/styles
		await this.removeStylesAndInjectedContent(view);

		const state = view.getState();
		const isRenderInHeader = this.settings.renderLocation === 'header';

		// Apply specific styles for Live Preview footer mode
		// These styles adjust padding to make space for the footer.
		if (state.mode === 'source' && !state.source && !isRenderInHeader) { // Live Preview editor mode, footer rendering
			this.applyLivePreviewFooterStyles(view);
		}

		// Inject content if in Preview mode or Live Preview editor mode
		if (state.mode === 'preview' || (state.mode === 'source' && !state.source)) {
			await this.renderAndInjectContent(view);
		}
	}

	// --- Content Rendering & Injection ---

	/**
	 * Renders the appropriate footer/header content for the given view and injects it into the DOM.
	 * It determines the content text based on the file path, prepares the HTML element,
	 * and then injects it into the correct location (header or footer area) depending on the
	 * view mode (Preview or Live Preview) and plugin settings.
	 * Also attaches handlers for internal links within the injected content.
	 * @param view The MarkdownView where the content will be injected.
	 */
	private async renderAndInjectContent(view: MarkdownView) {
		const filePath = view.file?.path || '';
		const contentText = this.getFooterTextForFile(filePath);

		if (!contentText) {
			await this.removeInjectedContentDOM(view); // Ensure removal if content becomes empty
			return;
		}

		const isRenderInHeader = this.settings.renderLocation === 'header';
		const { element: contentDiv, component } = await this.prepareContentElement(contentText, isRenderInHeader, filePath);

		let injectionSuccessful = false;
		const state = view.getState();

		if (state.mode === 'preview') {
			// Target the preview mode's header or footer area
			const targetParent = view.containerEl.querySelector<HTMLElement>(
				isRenderInHeader ? SELECTOR_PREVIEW_HEADER_AREA : SELECTOR_PREVIEW_FOOTER_AREA
			);
			if (targetParent) {
				targetParent.appendChild(contentDiv);
				injectionSuccessful = true;
			}
		} else if (state.mode === 'source' && !state.source) { // Live Preview editor mode
			if (isRenderInHeader) {
				// Target the area before the CodeMirror content container for header in Live Preview
				const cmContentContainer = view.containerEl.querySelector<HTMLElement>(SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER);
				if (cmContentContainer?.parentElement) {
					cmContentContainer.parentElement.insertBefore(contentDiv, cmContentContainer);
					injectionSuccessful = true;
				}
			} else { // Footer in Live Preview editor
				// Target the sizer element which is a reliable parent for appending footer content
				const targetParent = view.containerEl.querySelector<HTMLElement>(SELECTOR_EDITOR_SIZER);
				if (targetParent) {
					targetParent.appendChild(contentDiv);
					injectionSuccessful = true;
				}
			}
		}

		if (injectionSuccessful) {
			// If content was successfully injected, attach internal link handlers
			this.attachInternalLinkHandlers(contentDiv, filePath, component, view);
		} else {
			// If injection failed (e.g., target element not found), unload the component to free resources.
			// console.warn('VirtualFooterPlugin: Target for injection not found. Content not rendered.');
			component.unload();
		}
	}

	/**
	 * Creates and prepares an HTML element to hold the rendered Markdown content.
	 * It sets up a `div` with appropriate CSS classes, creates an Obsidian `Component`
	 * for lifecycle management of the rendered content (e.g., internal links),
	 * and then renders the provided Markdown text into this `div`.
	 * @param contentText The Markdown string to render.
	 * @param isRenderInHeader True if the content is for the header, false for the footer.
	 * @param sourcePath The path of the file for which this content is being rendered, used for Markdown rendering context.
	 * @returns A promise that resolves to an object containing the created HTMLElement and its associated Component.
	 */
	private async prepareContentElement(contentText: string, isRenderInHeader: boolean, sourcePath: string): Promise<{ element: HTMLElement; component: Component }> {
		const contentDiv = document.createElement('div');
		contentDiv.className = CSS_DYNAMIC_CONTENT_ELEMENT; // Base class for all dynamic content
		contentDiv.classList.add(isRenderInHeader ? CSS_HEADER_RENDERED_CONTENT : CSS_FOOTER_RENDERED_CONTENT); // Specific class for header/footer

		// Create a new component to manage the lifecycle of the rendered Markdown.
		// This is important for Obsidian's internal link handling and other dynamic features.
		const component = new Component();
		component.load(); // Load the component
		(contentDiv as HTMLElementWithComponent).component = component; // Store component reference on the element

		// Render the Markdown content into the div.
		await MarkdownRenderer.render(this.app, contentText, contentDiv, sourcePath, component);
		return { element: contentDiv, component };
	}

	// --- DOM Styling & Cleanup ---

	/**
	 * Applies specific CSS classes to elements within a MarkdownView when rendering
	 * a footer in Live Preview mode. These classes adjust padding and layout
	 * to accommodate the injected footer content.
	 * @param view The MarkdownView to style.
	 */
	private applyLivePreviewFooterStyles(view: MarkdownView): void {
		const contentEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_AREA);
		const containerEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT);
		contentEl?.classList.add(CSS_VIRTUAL_FOOTER_CM_PADDING); // Adds bottom padding to CodeMirror content
		containerEl?.classList.add(CSS_VIRTUAL_FOOTER_REMOVE_FLEX); // Modifies flex behavior of parent container
	}

	/**
	 * Removes the CSS classes previously applied by `applyLivePreviewFooterStyles`.
	 * This is used to clean up styles when the footer is removed or the view mode changes.
	 * @param view The MarkdownView from which to remove styles.
	 */
	private removeLivePreviewFooterStyles(view: MarkdownView): void {
		const contentEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_AREA);
		const containerEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT);
		contentEl?.classList.remove(CSS_VIRTUAL_FOOTER_CM_PADDING);
		containerEl?.classList.remove(CSS_VIRTUAL_FOOTER_REMOVE_FLEX);
	}

	/**
	 * Removes all dynamically injected content elements (footers/headers) from a specific view.
	 * It iterates through known parent selectors where content might be injected,
	 * finds elements with the `CSS_DYNAMIC_CONTENT_ELEMENT` class, unloads their
	 * associated Obsidian components, and then removes the elements from the DOM.
	 * @param view The MarkdownView from which to remove injected content.
	 */
	private async removeInjectedContentDOM(view: MarkdownView) {
		SELECTORS_POTENTIAL_DYNAMIC_CONTENT_PARENTS.forEach(selector => {
			const parentEl = view.containerEl.querySelector(selector);
			parentEl?.querySelectorAll(`.${CSS_DYNAMIC_CONTENT_ELEMENT}`).forEach(el => {
				const componentHolder = el as HTMLElementWithComponent;
				if (componentHolder.component) {
					componentHolder.component.unload(); // Unload the component to free resources
				}
				el.remove(); // Remove the element from the DOM
			});
		});
	}

	/**
	 * A utility method to remove both applied Live Preview styles and injected DOM content
	 * from a given Markdown view.
	 * @param view The MarkdownView to clean up.
	 */
	private async removeStylesAndInjectedContent(view: MarkdownView) {
		this.removeLivePreviewFooterStyles(view);
		await this.removeInjectedContentDOM(view);
	}

	/**
	 * Clears all injected content and styles from all open Markdown views in the workspace.
	 * Iterates through all 'markdown' type leaves and calls `removeStylesAndInjectedContent` for each.
	 */
	private clearAllViews(): void {
		this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
			if (leaf.view instanceof MarkdownView) {
				this.removeStylesAndInjectedContent(leaf.view);
			}
		});
	}

	// --- Utility Methods ---

	/**
	 * Determines the appropriate footer/header text for a given file path based on the
	 * plugin's configured rules. It finds the rule with the longest matching folder path.
	 * @param filePath The path of the file to find footer text for.
	 * @returns The footer/header text string if a matching rule is found, otherwise an empty string.
	 */
	private getFooterTextForFile(filePath: string): string {
		let bestMatchPath = '';
		let footerText = '';
		// Iterate through rules to find the most specific match (longest folder path)
		for (const rule of this.settings.rules) {
			if (filePath.startsWith(rule.folderPath) && rule.folderPath.length >= bestMatchPath.length) {
				bestMatchPath = rule.folderPath;
				footerText = rule.footerText;
			}
		}
		return footerText;
	}

	/**
	 * Attaches click event handlers to internal links (`<a class="internal-link">`)
	 * within the injected content container. This ensures that Obsidian's internal link
	 * navigation (including opening in new panes with Ctrl/Cmd click) works correctly.
	 * @param container The HTMLElement containing the rendered Markdown content.
	 * @param sourcePath The path of the file where the content is displayed, used as context for link resolution.
	 * @param component The Obsidian Component associated with the rendered content, used to register DOM events.
	 * @param view The MarkdownView instance, currently unused but kept for potential future use.
	 */
	private attachInternalLinkHandlers(container: HTMLElement, sourcePath: string, component: Component, view: MarkdownView) {
		// Register a DOM event listener on the component for click events within the container.
		component.registerDomEvent(container, 'click', (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			const link = target.closest('a.internal-link') as HTMLAnchorElement; // Find the closest internal link ancestor

			if (link) {
				event.preventDefault(); // Prevent default link navigation
				const href = link.dataset.href; // Get the link destination from data-href attribute
				if (href) {
					const newPane = event.ctrlKey || event.metaKey; // Check for Ctrl/Cmd key for new pane
					this.app.workspace.openLinkText(href, sourcePath, newPane); // Use Obsidian API to open link
				}
			}
		});
	}

	// --- Settings Persistence ---

	/**
	 * Loads plugin settings from Obsidian's data storage.
	 * Merges stored settings with default settings to ensure all properties are present.
	 */
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	/**
	 * Saves the current plugin settings to Obsidian's data storage.
	 */
	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class VirtualFooterSettingTab extends PluginSettingTab {
	plugin: VirtualFooterPlugin;
	private allFilePaths: Set<string> | null = null;

	constructor(app: App, plugin: VirtualFooterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private generateAllFilePaths(): Set<string> {
		if (this.allFilePaths) return this.allFilePaths;

		const paths = new Set<string>(['/']);
		this.plugin.app.vault.getAllLoadedFiles().forEach(file => {
			if (file instanceof TFile && file.parent) {
				paths.add(file.parent.path === '/' ? '/' : file.parent.path + '/');
			} else if ('children' in file && file.path !== '/') { // TFolder
				paths.add(file.path + '/');
			}
		});
		this.allFilePaths = paths;
		return paths;
	}
	
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.allFilePaths = null; // Reset cached paths for re-display

		new Setting(containerEl)
			.setName('Render location')
			.setDesc('Choose where to render the content in the view.')
			.addDropdown(dropdown => dropdown
				.addOption('footer', 'Footer')
				.addOption('header', 'Header')
				.setValue(this.plugin.settings.renderLocation)
				.onChange(async (value: 'footer' | 'header') => {
					this.plugin.settings.renderLocation = value;
					await this.plugin.saveSettings();
					this.plugin.handleActiveViewChange();
				}));

		const rulesContainer = containerEl.createDiv();
		rulesContainer.addClass('rules-container');

		if (!this.plugin.settings.rules) {
			this.plugin.settings.rules = [];
		}

		this.plugin.settings.rules.forEach((rule, index) => {
			this.renderRuleControls(rule, index, rulesContainer);
		});

		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('Add rule')
				.setClass('virtual-footer-add-button')
				.onClick(async () => {
					this.plugin.settings.rules.push({ folderPath: '', footerText: '' });
					await this.plugin.saveSettings();
					this.display(); // Re-render the entire settings tab
					this.plugin.handleActiveViewChange(); // Update views
				}));
	}

	private renderRuleControls(rule: { folderPath: string; footerText: string }, index: number, containerEl: HTMLElement) {
		const ruleDiv = containerEl.createDiv();
		ruleDiv.addClass('rule');

		new Setting(ruleDiv)
			.setName(`Folder path ${index + 1}`)
			.setDesc('Path in the vault. Content will apply to notes in this folder and its subfolders. Use "/" for all notes.')
			.addText(text => {
				text.setPlaceholder('e.g., Meetings/ or /')
					.setValue(rule.folderPath)
					.onChange(async (value) => {
						this.plugin.settings.rules[index].folderPath = value;
						await this.plugin.saveSettings();
						this.plugin.handleActiveViewChange();
					});
				new MultiSuggest(text.inputEl, this.generateAllFilePaths(), (selectedPath) => {
					this.plugin.settings.rules[index].folderPath = selectedPath;
					this.plugin.saveSettings(); // await not strictly needed if not chaining
					this.plugin.handleActiveViewChange();
					text.setValue(selectedPath); // Ensure text input updates
				}, this.plugin.app);
			});

		new Setting(ruleDiv)
			.setName(`Content text ${index + 1}`)
			.setDesc('Markdown text to display.')
			.addTextArea(text => text
				.setPlaceholder('Enter your markdown content here...')
				.setValue(rule.footerText)
				.onChange(async (value) => {
					this.plugin.settings.rules[index].footerText = value;
					await this.plugin.saveSettings();
					this.plugin.handleActiveViewChange();
				}));

		new Setting(ruleDiv)
			.addButton(button => button
				.setButtonText('Delete rule')
				.setClass('virtual-footer-delete-button')
				.onClick(async () => {
					this.plugin.settings.rules.splice(index, 1);
					await this.plugin.saveSettings();
					this.display(); // Re-render the entire settings tab
					this.plugin.handleActiveViewChange(); // Update views
				}));

		ruleDiv.createEl('hr');
	}
}
