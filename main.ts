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
}

// --- Interfaces ---

/**
 * Represents a rule for injecting dynamic content into Markdown views.
 * Each rule specifies matching criteria (type: folder/tag/property), content source (text/file),
 * the content itself, and where it should be rendered (header/footer).
 */
interface Rule {
	/** A descriptive name for this rule. */
	name?: string; // Added
	/** Whether this rule is currently active. */
	enabled?: boolean; // Added
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
	footerText: string;
	/** Path to a .md file if contentSource is 'file'. */
	footerFilePath?: string;
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
 */
interface HTMLElementWithComponent extends HTMLElement {
	component?: Component;
}

// --- Constants ---

/** Default settings for the plugin, used when no settings are found or for new rules. */
const DEFAULT_SETTINGS: VirtualFooterSettings = {
	rules: [{
		name: '', // Added
		enabled: true, // Added
		type: RuleType.Folder,
		path: '',
		recursive: true,
		contentSource: ContentSource.Text,
		footerText: '',
		renderLocation: RenderLocation.Footer,
	}],
};

// CSS Classes for styling and identifying plugin-generated elements
const CSS_DYNAMIC_CONTENT_ELEMENT = 'virtual-footer-dynamic-content-element';
const CSS_HEADER_GROUP_ELEMENT = 'virtual-footer-header-group';
const CSS_FOOTER_GROUP_ELEMENT = 'virtual-footer-footer-group';
const CSS_HEADER_RENDERED_CONTENT = 'virtual-footer-header-rendered-content';
const CSS_FOOTER_RENDERED_CONTENT = 'virtual-footer-footer-rendered-content';
const CSS_VIRTUAL_FOOTER_CM_PADDING = 'virtual-footer-cm-padding';
const CSS_VIRTUAL_FOOTER_REMOVE_FLEX = 'virtual-footer-remove-flex';

// DOM Selectors
const SELECTOR_EDITOR_CONTENT_AREA = '.cm-editor .cm-content';
const SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT = '.markdown-source-view.mod-cm6 .cm-contentContainer';
const SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER = '.cm-contentContainer';
const SELECTOR_EDITOR_SIZER = '.cm-sizer';
const SELECTOR_PREVIEW_HEADER_AREA = '.mod-header.mod-ui';
const SELECTOR_PREVIEW_FOOTER_AREA = '.mod-footer';

const SELECTORS_POTENTIAL_DYNAMIC_CONTENT_PARENTS = [
	SELECTOR_EDITOR_SIZER,
	SELECTOR_PREVIEW_FOOTER_AREA,
	SELECTOR_PREVIEW_HEADER_AREA,
	SELECTOR_LIVE_PREVIEW_CONTENT_CONTAINER,
	'.metadata-container .metadata-content',
	'.view-header',
];

// --- Utility Classes ---
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
		this.inputEl.value = content;
		this.inputEl.blur();
		this.close();
	}
}

// --- Main Plugin Class ---
export default class VirtualFooterPlugin extends Plugin {
	settings: VirtualFooterSettings;
	private pendingPreviewInjections: WeakMap<MarkdownView, { headerDiv?: HTMLElementWithComponent, footerDiv?: HTMLElementWithComponent }> = new WeakMap();
	private previewObservers: WeakMap<MarkdownView, MutationObserver> = new WeakMap();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new VirtualFooterSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on('file-open', this.handleActiveViewChange)
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', this.handleActiveViewChange)
		);
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.path === file.path) {
					this.handleActiveViewChange();
				}
			})
		);
		this.handleActiveViewChange();
	}

	async onunload() {
		this.clearAllViewsDynamicContent();
		document.querySelectorAll(`.${CSS_DYNAMIC_CONTENT_ELEMENT}`).forEach(el => {
			const componentHolder = el as HTMLElementWithComponent;
			if (componentHolder.component) {
				componentHolder.component.unload();
			}
			el.remove();
		});
		document.querySelectorAll(`.${CSS_VIRTUAL_FOOTER_CM_PADDING}`).forEach(el => el.classList.remove(CSS_VIRTUAL_FOOTER_CM_PADDING));
		document.querySelectorAll(`.${CSS_VIRTUAL_FOOTER_REMOVE_FLEX}`).forEach(el => el.classList.remove(CSS_VIRTUAL_FOOTER_REMOVE_FLEX));
		this.previewObservers.forEach(observer => observer.disconnect());
		this.previewObservers = new WeakMap();
		this.pendingPreviewInjections.forEach(pending => {
			pending.headerDiv?.component?.unload();
			pending.footerDiv?.component?.unload();
		});
		this.pendingPreviewInjections = new WeakMap();
	}

	private handleActiveViewChange = () => {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		this._processView(activeView);
	}

	private async _processView(view: MarkdownView | null): Promise<void> {
		if (!view || !view.file) {
			return;
		}
		await this.removeDynamicContentFromView(view);
		const applicableRulesWithContent = await this._getApplicableRulesAndContent(view.file.path);
		if (applicableRulesWithContent.length === 0) {
			return;
		}
		const viewState = view.getState();
		let combinedHeaderText = "";
		let combinedFooterText = "";
		let hasFooterRule = false;
		const contentSeparator = "\n\n";
		for (const { rule, contentText } of applicableRulesWithContent) {
			if (!contentText || contentText.trim() === "") continue;
			if (rule.renderLocation === RenderLocation.Header) {
				combinedHeaderText += (combinedHeaderText ? contentSeparator : "") + contentText;
			} else {
				combinedFooterText += (combinedFooterText ? contentSeparator : "") + contentText;
				hasFooterRule = true;
			}
		}
		if (viewState.mode === 'source' && !viewState.source && hasFooterRule) {
			this.applyLivePreviewFooterStyles(view);
		}
		let pendingHeaderDiv: HTMLElementWithComponent | null = null;
		let pendingFooterDiv: HTMLElementWithComponent | null = null;
		if (viewState.mode === 'preview' || (viewState.mode === 'source' && !viewState.source)) {
			if (combinedHeaderText.trim()) {
				const result = await this.renderAndInjectGroupedContent(view, combinedHeaderText, RenderLocation.Header);
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
		if (pendingHeaderDiv || pendingFooterDiv) {
			let pending = this.pendingPreviewInjections.get(view);
			if (!pending) {
				pending = {};
				this.pendingPreviewInjections.set(view, pending);
			}
			if (pendingHeaderDiv) pending.headerDiv = pendingHeaderDiv;
			if (pendingFooterDiv) pending.footerDiv = pendingFooterDiv;
			this.ensurePreviewObserver(view);
		}
	}

	private async renderAndInjectGroupedContent(
		view: MarkdownView,
		combinedContentText: string,
		renderLocation: RenderLocation
	): Promise<HTMLElementWithComponent | null> {
		if (!combinedContentText || combinedContentText.trim() === "") {
			return null;
		}
		const isRenderInHeader = renderLocation === RenderLocation.Header;
		const sourcePath = view.file?.path || '';
		const groupDiv = document.createElement('div') as HTMLElementWithComponent;
		groupDiv.className = CSS_DYNAMIC_CONTENT_ELEMENT;
		groupDiv.classList.add(
			isRenderInHeader ? CSS_HEADER_GROUP_ELEMENT : CSS_FOOTER_GROUP_ELEMENT,
			isRenderInHeader ? CSS_HEADER_RENDERED_CONTENT : CSS_FOOTER_RENDERED_CONTENT
		);
		const component = new Component();
		component.load();
		groupDiv.component = component;
		await MarkdownRenderer.render(this.app, combinedContentText, groupDiv, sourcePath, component);
		let injectionSuccessful = false;
		const viewState = view.getState();
		if (viewState.mode === 'preview') {
			const previewContentParent = view.previewMode.containerEl;
			const targetParent = previewContentParent.querySelector<HTMLElement>(
				isRenderInHeader ? SELECTOR_PREVIEW_HEADER_AREA : SELECTOR_PREVIEW_FOOTER_AREA
			);
			if (targetParent) {
				targetParent.appendChild(groupDiv);
				injectionSuccessful = true;
			}
		} else if (viewState.mode === 'source' && !viewState.source) {
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
			return null;
		} else {
			if (viewState.mode === 'preview') {
				console.log(`VirtualFooter: Deferring injection for ${renderLocation} in preview mode. Target not found yet.`);
				return groupDiv;
			} else {
				component.unload();
				console.warn(`VirtualFooter: Failed to find injection point for dynamic content group (${renderLocation}). View mode: ${viewState.mode}.`);
				return null;
			}
		}
	}

	private ensurePreviewObserver(view: MarkdownView): void {
		if (this.previewObservers.has(view) || !view.file || !view.previewMode?.containerEl) {
			return;
		}
		const observer = new MutationObserver((mutations) => {
			if (!view.file) {
				observer.disconnect();
				this.previewObservers.delete(view);
				const pendingStale = this.pendingPreviewInjections.get(view);
				if (pendingStale) {
					pendingStale.headerDiv?.component?.unload();
					pendingStale.footerDiv?.component?.unload();
					this.pendingPreviewInjections.delete(view);
				}
				return;
			}
			const pending = this.pendingPreviewInjections.get(view);
			if (!pending || (!pending.headerDiv && !pending.footerDiv)) {
				observer.disconnect();
				this.previewObservers.delete(view);
				if (pending) this.pendingPreviewInjections.delete(view);
				return;
			}
			let allResolved = true;
			const sourcePath = view.file.path;
			if (pending.headerDiv) {
				const headerTargetParent = view.previewMode.containerEl.querySelector<HTMLElement>(SELECTOR_PREVIEW_HEADER_AREA);
				if (headerTargetParent) {
					headerTargetParent.appendChild(pending.headerDiv);
					if (pending.headerDiv.component) {
						this.attachInternalLinkHandlers(pending.headerDiv, sourcePath, pending.headerDiv.component);
					}
					delete pending.headerDiv;
				} else {
					allResolved = false;
				}
			}
			if (pending.footerDiv) {
				const footerTargetParent = view.previewMode.containerEl.querySelector<HTMLElement>(SELECTOR_PREVIEW_FOOTER_AREA);
				if (footerTargetParent) {
					footerTargetParent.appendChild(pending.footerDiv);
					if (pending.footerDiv.component) {
						this.attachInternalLinkHandlers(pending.footerDiv, sourcePath, pending.footerDiv.component);
					}
					delete pending.footerDiv;
				} else {
					allResolved = false;
				}
			}
			if (allResolved) {
				observer.disconnect();
				this.previewObservers.delete(view);
				this.pendingPreviewInjections.delete(view);
			}
		});
		observer.observe(view.previewMode.containerEl, { childList: true, subtree: true });
		this.previewObservers.set(view, observer);
	}

	private applyLivePreviewFooterStyles(view: MarkdownView): void {
		const contentEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_AREA);
		const containerEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT);
		contentEl?.classList.add(CSS_VIRTUAL_FOOTER_CM_PADDING);
		containerEl?.classList.add(CSS_VIRTUAL_FOOTER_REMOVE_FLEX);
	}

	private removeLivePreviewFooterStyles(viewOrContainer: MarkdownView | HTMLElement): void {
		const container = viewOrContainer instanceof MarkdownView ? viewOrContainer.containerEl : viewOrContainer;
		const contentEl = container.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_AREA);
		const containerEl = container.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT);
		contentEl?.classList.remove(CSS_VIRTUAL_FOOTER_CM_PADDING);
		containerEl?.classList.remove(CSS_VIRTUAL_FOOTER_REMOVE_FLEX);
	}

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

	private async removeDynamicContentFromView(view: MarkdownView): Promise<void> {
		this.removeLivePreviewFooterStyles(view);
		await this.removeInjectedContentDOM(view.containerEl);
		const observer = this.previewObservers.get(view);
		if (observer) {
			observer.disconnect();
			this.previewObservers.delete(view);
		}
		const pending = this.pendingPreviewInjections.get(view);
		if (pending) {
			if (pending.headerDiv?.component) {
				pending.headerDiv.component.unload();
			}
			if (pending.footerDiv?.component) {
				pending.footerDiv.component.unload();
			}
			this.pendingPreviewInjections.delete(view);
		}
	}

	private clearAllViewsDynamicContent(): void {
		this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
			if (leaf.view instanceof MarkdownView) {
				this.removeDynamicContentFromView(leaf.view);
			}
		});
	}

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
			// Skip disabled rules
			if (!currentRule.enabled) {
				continue;
			}

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
			} else if (currentRule.type === RuleType.Property && currentRule.propertyName && fileCache?.frontmatter) {
				const propertyKey = currentRule.propertyName;
				const expectedPropertyValue = currentRule.propertyValue;
				const actualPropertyValue = fileCache.frontmatter[propertyKey];
				if (actualPropertyValue !== undefined && actualPropertyValue !== null) {
					if (typeof actualPropertyValue === 'string') {
						if (actualPropertyValue === expectedPropertyValue) {
							isMatch = true;
						}
					} else if (Array.isArray(actualPropertyValue)) {
						if (actualPropertyValue.map(String).includes(expectedPropertyValue!)) {
							isMatch = true;
						}
					} else if (typeof actualPropertyValue === 'number' || typeof actualPropertyValue === 'boolean') {
						if (String(actualPropertyValue) === expectedPropertyValue) {
							isMatch = true;
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

	async loadSettings() {
		const loadedData = await this.loadData();
		this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); // Start with deep copy of defaults

		if (loadedData) {
			const oldGlobalRenderLocation = loadedData.renderLocation as RenderLocation | undefined;

			if (loadedData.rules && Array.isArray(loadedData.rules)) {
				this.settings.rules = loadedData.rules.map((loadedRule: any) =>
					this._migrateRule(loadedRule, oldGlobalRenderLocation)
				);
			}
		}

		// Ensure there's at least one rule, and all rules are normalized
		if (!this.settings.rules || this.settings.rules.length === 0) {
			this.settings.rules = [JSON.parse(JSON.stringify(DEFAULT_SETTINGS.rules[0]))]; // Add a default rule
			this.normalizeRule(this.settings.rules[0]);
		} else {
			this.settings.rules.forEach(rule => this.normalizeRule(rule));
		}
	}

	private _migrateRule(loadedRule: any, globalRenderLocation?: RenderLocation): Rule {
		let type: RuleType;
		if (loadedRule.type === RuleType.Folder || loadedRule.type === RuleType.Tag || loadedRule.type === RuleType.Property) {
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
			name: loadedRule.name || DEFAULT_SETTINGS.rules[0].name, // Added
			enabled: loadedRule.enabled !== undefined ? loadedRule.enabled : DEFAULT_SETTINGS.rules[0].enabled, // Added
			type: type,
			contentSource: contentSource,
			footerText: loadedRule.footerText || '',
			renderLocation: loadedRule.renderLocation || globalRenderLocation || DEFAULT_SETTINGS.rules[0].renderLocation,
			recursive: loadedRule.recursive !== undefined ? loadedRule.recursive : true,
		};

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

		if (migratedRule.contentSource === ContentSource.File) {
			migratedRule.footerFilePath = loadedRule.footerFilePath || '';
		}
		return migratedRule;
	}

	public normalizeRule(rule: Rule): void {
		rule.name = rule.name === undefined ? DEFAULT_SETTINGS.rules[0].name : rule.name; // Added
		rule.enabled = typeof rule.enabled === 'boolean' ? rule.enabled : DEFAULT_SETTINGS.rules[0].enabled!; // Added

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

		rule.contentSource = rule.contentSource || DEFAULT_SETTINGS.rules[0].contentSource;
		rule.footerText = rule.footerText || '';
		rule.renderLocation = rule.renderLocation || DEFAULT_SETTINGS.rules[0].renderLocation;

		if (rule.contentSource === ContentSource.File) {
			rule.footerFilePath = rule.footerFilePath || '';
		} else {
			delete rule.footerFilePath;
		}
	}

	async saveSettings() {
		this.settings.rules.forEach(rule => this.normalizeRule(rule));
		await this.saveData(this.settings);
		this.handleActiveViewChange();
	}
}

/**
 * Manages the settings tab for the VirtualFooter plugin.
 */
class VirtualFooterSettingTab extends PluginSettingTab {
	private allFolderPathsCache: Set<string> | null = null;
	private allTagsCache: Set<string> | null = null;
	private allMarkdownFilePathsCache: Set<string> | null = null;
	private allPropertyNamesCache: Set<string> | null = null;

	constructor(app: App, private plugin: VirtualFooterPlugin) {
		super(app, plugin);
	}

	private getAvailableFolderPaths(): Set<string> {
		if (this.allFolderPathsCache) return this.allFolderPathsCache;
		const paths = new Set<string>(['/', '']);
		this.app.vault.getAllLoadedFiles().forEach(file => {
			if (file.parent) {
				const parentPath = file.parent.isRoot() ? '/' : (file.parent.path.endsWith('/') ? file.parent.path : file.parent.path + '/');
				if (parentPath !== '/') paths.add(parentPath);
			}
			if ('children' in file && file.path !== '/') {
				const folderPath = file.path.endsWith('/') ? file.path : file.path + '/';
				paths.add(folderPath);
			}
		});
		this.allFolderPathsCache = paths;
		return paths;
	}

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

	private getAvailableMarkdownFilePaths(): Set<string> {
		if (this.allMarkdownFilePathsCache) return this.allMarkdownFilePathsCache;
		const paths = new Set<string>();
		this.app.vault.getMarkdownFiles().forEach(file => {
			paths.add(file.path);
		});
		this.allMarkdownFilePathsCache = paths;
		return paths;
	}

	private getAvailablePropertyNames(): Set<string> {
		if (this.allPropertyNamesCache) return this.allPropertyNamesCache;
		// @ts-ignore
		const keys = this.app.metadataCache.getFrontmatterPropertyKeys?.() || [];
		this.allPropertyNamesCache = new Set(keys);
		return this.allPropertyNamesCache;
	}

	/**
	 * Renders the settings tab UI.
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Clear caches to refresh suggestions on each display
		this.allFolderPathsCache = null;
		this.allTagsCache = null;
		this.allMarkdownFilePathsCache = null;
		this.allPropertyNamesCache = null;

		// Add this CSS to your plugin's styles.css for collapsibility and icons
		// You can add it directly to the plugin's styles.css or load it dynamically.
		/*
		.virtual-footer-rule-item h4 {
			cursor: pointer;
			user-select: none;
			position: relative;
			padding-left: 22px; // Space for the icon
			margin-bottom: 0.5em; 
		}
		.virtual-footer-rule-item h4::before {
			content: '▶'; // Collapsed state: right-pointing triangle
			position: absolute;
			left: 0;
			top: 50%;
			transform: translateY(-50%) scale(0.9);
			font-size: 1em; // Adjust size as needed
		}
		.virtual-footer-rule-item:not(.is-collapsed) h4::before {
			content: '▼'; // Expanded state: down-pointing triangle
		}
		.virtual-footer-rule-item.is-collapsed .virtual-footer-rule-content {
			display: none;
		}
		.virtual-footer-rule-content {
			padding-left: 22px; // Indent content to align with text after icon
			// border-left: 1px solid var(--background-modifier-border); // Optional visual cue
			// margin-left: 2px; // Align border with icon center
			padding-bottom: 10px;
		}
		.virtual-footer-rule-item hr.virtual-footer-rule-divider {
			margin-top: 15px;
			margin-bottom: 15px;
		}
		*/


		containerEl.createEl('h2', { text: 'Virtual Content Settings' });
		containerEl.createEl('p', { text: 'Define rules to dynamically add content to the header or footer of notes based on their folder, tags, or properties.' });
		containerEl.createEl('h3', { text: 'Rules' });
		const rulesContainer = containerEl.createDiv('rules-container virtual-footer-rules-container');

		if (!this.plugin.settings.rules) {
			this.plugin.settings.rules = [];
		}
		if (this.plugin.settings.rules.length === 0) {
			const newRule = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.rules[0]));
			this.plugin.normalizeRule(newRule);
			this.plugin.settings.rules.push(newRule);
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
					this.plugin.normalizeRule(newRule);
					this.plugin.settings.rules.push(newRule);
					await this.plugin.saveSettings();
					this.display(); // Re-render to show the new rule
				}));
	}

	/**
	 * Renders the UI controls for a single rule.
	 */
	private renderRuleControls(rule: Rule, index: number, containerEl: HTMLElement): void {
		const ruleDiv = containerEl.createDiv('rule-item virtual-footer-rule-item');
		ruleDiv.addClass('is-collapsed'); // Rules are collapsed by default

		const ruleNameDisplay = (rule.name && rule.name.trim() !== '') ? rule.name : 'Unnamed';
		const ruleHeadingText = `Rule ${index + 1} - ${ruleNameDisplay}`;
		const ruleHeading = ruleDiv.createEl('h4', { text: ruleHeadingText });

		const ruleContentContainer = ruleDiv.createDiv('virtual-footer-rule-content');

		ruleHeading.addEventListener('click', () => {
			ruleDiv.toggleClass('is-collapsed', !ruleDiv.classList.contains('is-collapsed'));
		});

		// --- Rule Name Setting ---
		new Setting(ruleContentContainer)
			.setName('Rule name')
			.setDesc('A descriptive name for this rule.')
			.addText(text => text
				.setPlaceholder('e.g., Blog Post Footer')
				.setValue(rule.name || '')
				.onChange(async (value) => {
					rule.name = value;
					const newNameDisplay = (value && value.trim() !== '') ? value : 'Unnamed';
					ruleHeading.textContent = `Rule ${index + 1} - ${newNameDisplay}`;
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
						this.plugin.saveSettings().then(() => this.display());
					}, this.plugin.app);
				});

			new Setting(ruleContentContainer)
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
			new Setting(ruleContentContainer)
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

			new Setting(ruleContentContainer)
				.setName('Include subtags')
				.setDesc("If enabled, a rule for 'tag' will also apply to 'tag/subtag1', 'tag/subtag2/subtag3', etc. If disabled, it only applies to the exact tag.")
				.addToggle(toggle => {
					toggle.setValue(rule.includeSubtags!)
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
			.setDesc('Where to get the content from.')
			.addDropdown(dropdown => dropdown
				.addOption(ContentSource.Text, 'Direct text')
				.addOption(ContentSource.File, 'Markdown file')
				.setValue(rule.contentSource || ContentSource.Text)
				.onChange(async (value: string) => {
					rule.contentSource = value as ContentSource;
					this.plugin.normalizeRule(rule);
					await this.plugin.saveSettings();
					this.display(); // Re-render for content source specific fields
				}));

		if (rule.contentSource === ContentSource.File) {
			new Setting(ruleContentContainer)
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
		} else { // ContentSource.Text
			new Setting(ruleContentContainer)
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

		// --- Render Location Setting ---
		new Setting(ruleContentContainer)
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

		// --- Delete Rule Button ---
		new Setting(ruleContentContainer)
			.addButton(button => button
				.setButtonText('Delete rule')
				.setWarning()
				.setClass('virtual-footer-delete-button')
				.onClick(async () => {
					this.plugin.settings.rules.splice(index, 1);
					await this.plugin.saveSettings();
					this.display(); // Re-render after deleting a rule
				}));
	}
}
