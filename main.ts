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
	getAllTags // Ensure getAllTags is imported
} from 'obsidian';

// Interfaces
interface Rule {
	type: 'folder' | 'tag';
	path?: string;      // For folder type
	tag?: string;       // For tag type
	contentSource: 'text' | 'file'; // New: 'text' for direct input, 'file' for .md file
	footerText: string; // Used if contentSource is 'text'
	footerFilePath?: string; // Path to .md file if contentSource is 'file'
}

interface VirtualFooterSettings {
	rules: Rule[];
	renderLocation: 'footer' | 'header';
}

interface HTMLElementWithComponent extends HTMLElement {
	component?: Component;
}

// Constants
const DEFAULT_SETTINGS: VirtualFooterSettings = {
	rules: [{ type: 'folder', path: '', contentSource: 'text', footerText: '' }], // Updated default rule
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
 * that is dynamically injected into Markdown views based on folder-specific or tag-specific rules.
 */
export default class VirtualFooterPlugin extends Plugin {
	settings: VirtualFooterSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new VirtualFooterSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on('file-open', () => this.handleActiveViewChange())
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', () => this.handleActiveViewChange())
		);
		this.handleActiveViewChange();
	}

	async onunload() {
		this.clearAllViews();

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

	handleActiveViewChange() {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		this._processView(activeView);
	}

	private async _processView(view: MarkdownView | null) {
		if (!view || !view.file) {
			this.clearAllViews();
			return;
		}

		await this.removeStylesAndInjectedContent(view);

		const state = view.getState();
		const isRenderInHeader = this.settings.renderLocation === 'header';

		if (state.mode === 'source' && !state.source && !isRenderInHeader) {
			this.applyLivePreviewFooterStyles(view);
		}

		if (state.mode === 'preview' || (state.mode === 'source' && !state.source)) {
			await this.renderAndInjectContent(view);
		}
	}

	private async renderAndInjectContent(view: MarkdownView) {
		const filePath = view.file?.path || '';
		const contentText = await this.getFooterTextForFile(filePath); // Now async

		if (!contentText) {
			await this.removeInjectedContentDOM(view);
			return;
		}

		const isRenderInHeader = this.settings.renderLocation === 'header';
		const { element: contentDiv, component } = await this.prepareContentElement(contentText, isRenderInHeader, filePath);

		let injectionSuccessful = false;
		const state = view.getState();

		if (state.mode === 'preview') {
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
			} else {
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
			component.unload();
		}
	}

	private async prepareContentElement(contentText: string, isRenderInHeader: boolean, sourcePath: string): Promise<{ element: HTMLElement; component: Component }> {
		const contentDiv = document.createElement('div');
		contentDiv.className = CSS_DYNAMIC_CONTENT_ELEMENT;
		contentDiv.classList.add(isRenderInHeader ? CSS_HEADER_RENDERED_CONTENT : CSS_FOOTER_RENDERED_CONTENT);

		const component = new Component();
		component.load();
		(contentDiv as HTMLElementWithComponent).component = component;

		await MarkdownRenderer.render(this.app, contentText, contentDiv, sourcePath, component);
		return { element: contentDiv, component };
	}

	private applyLivePreviewFooterStyles(view: MarkdownView): void {
		const contentEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_AREA);
		const containerEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT);
		contentEl?.classList.add(CSS_VIRTUAL_FOOTER_CM_PADDING);
		containerEl?.classList.add(CSS_VIRTUAL_FOOTER_REMOVE_FLEX);
	}

	private removeLivePreviewFooterStyles(view: MarkdownView): void {
		const contentEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_AREA);
		const containerEl = view.containerEl.querySelector<HTMLDivElement>(SELECTOR_EDITOR_CONTENT_CONTAINER_PARENT);
		contentEl?.classList.remove(CSS_VIRTUAL_FOOTER_CM_PADDING);
		containerEl?.classList.remove(CSS_VIRTUAL_FOOTER_REMOVE_FLEX);
	}

	private async removeInjectedContentDOM(view: MarkdownView) {
		SELECTORS_POTENTIAL_DYNAMIC_CONTENT_PARENTS.forEach(selector => {
			const parentEl = view.containerEl.querySelector(selector);
			parentEl?.querySelectorAll(`.${CSS_DYNAMIC_CONTENT_ELEMENT}`).forEach(el => {
				const componentHolder = el as HTMLElementWithComponent;
				if (componentHolder.component) {
					componentHolder.component.unload();
				}
				el.remove();
			});
		});
	}

	private async removeStylesAndInjectedContent(view: MarkdownView) {
		this.removeLivePreviewFooterStyles(view);
		await this.removeInjectedContentDOM(view);
	}

	private clearAllViews(): void {
		this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
			if (leaf.view instanceof MarkdownView) {
				this.removeStylesAndInjectedContent(leaf.view);
			}
		});
	}

	private async getFooterTextForFile(filePath: string): Promise<string> {
		let bestMatchFolderRule: Rule | null = null;
		let bestMatchFolderSpecificity = -1;
		let folderRuleTextContent = "";

		// 1. Determine the best matching folder rule
		for (const rule of this.settings.rules) {
			if (rule.type === 'folder' && rule.path !== undefined) {
				let isMatch = false;
				let currentRuleSpecificity = -1;

				if (rule.path === "") { // Empty string path rule applies to all files
					isMatch = true;
					currentRuleSpecificity = 0; // Least specific
				} else if (rule.path === "/") { // Root folder path rule
					const fileForPath = this.app.vault.getAbstractFileByPath(filePath);
					if (fileForPath instanceof TFile && fileForPath.parent && fileForPath.parent.isRoot()) {
						isMatch = true;
						currentRuleSpecificity = 1; // More specific than ""
					}
				} else { // Regular folder path (e.g., "Meetings/")
					if (filePath.startsWith(rule.path)) {
						isMatch = true;
						currentRuleSpecificity = rule.path.length;
					}
				}

				if (isMatch) {
					if (currentRuleSpecificity >= bestMatchFolderSpecificity) {
						bestMatchFolderSpecificity = currentRuleSpecificity;
						bestMatchFolderRule = rule;
					}
				}
			}
		}

		// 2. If a folder rule is matched, try to get its content
		if (bestMatchFolderRule) {
			if (bestMatchFolderRule.contentSource === 'file' && bestMatchFolderRule.footerFilePath) {
				const file = this.app.vault.getAbstractFileByPath(bestMatchFolderRule.footerFilePath);
				if (file instanceof TFile) {
					folderRuleTextContent = await this.app.vault.cachedRead(file);
				} else {
					console.warn(`VirtualFooter: Content file not found for folder rule: ${bestMatchFolderRule.footerFilePath}`);
					folderRuleTextContent = ""; // File not found, treat as empty content
				}
			} else { // contentSource is 'text'
				folderRuleTextContent = bestMatchFolderRule.footerText;
			}
		}

		// 3. If folder rule provided non-empty text, return it
		if (folderRuleTextContent) {
			return folderRuleTextContent;
		}

		// 4. Else (no folder rule matched, or matched folder rule had empty content), check tag rules
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			const fileCache = this.app.metadataCache.getFileCache(file);
			if (fileCache) {
				const allTagsInFileWithHash = getAllTags(fileCache);
				const fileTags = allTagsInFileWithHash ? allTagsInFileWithHash.map(tag => tag.substring(1)) : [];

				for (const rule of this.settings.rules) {
					if (rule.type === 'tag' && rule.tag && fileTags.includes(rule.tag)) {
						// First matching tag rule
						if (rule.contentSource === 'file' && rule.footerFilePath) {
							const contentFile = this.app.vault.getAbstractFileByPath(rule.footerFilePath);
							if (contentFile instanceof TFile) {
								return await this.app.vault.cachedRead(contentFile);
							} else {
								console.warn(`VirtualFooter: Content file not found for tag rule: ${rule.footerFilePath}`);
								return ""; // File not found for this tag rule, return empty as it's the first match
							}
						} else { // contentSource is 'text'
							return rule.footerText;
						}
					}
				}
			}
		}

		// 5. If no rules matched or provided text, return ''
		return '';
	}


	private attachInternalLinkHandlers(container: HTMLElement, sourcePath: string, component: Component) {
		// Handle left-clicks and Ctrl/Meta + left-clicks
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

		// Handle middle-clicks
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

	async loadSettings() {
		const loadedData = await this.loadData();
		// Start with a deep copy of default settings
		this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
	
		if (loadedData) {
			this.settings.renderLocation = loadedData.renderLocation || DEFAULT_SETTINGS.renderLocation;
			if (loadedData.rules && Array.isArray(loadedData.rules)) {
				this.settings.rules = loadedData.rules.map((rule: any): Rule => {
					// Determine type, handling old 'folderPath'
					let type = rule.type;
					if (!type && typeof rule.folderPath === 'string') {
						type = 'folder';
					}
					type = type || 'folder'; // Default to folder if still undefined
	
					// Determine contentSource, defaulting to 'text'
					// If old rule (had folderPath, no contentSource), it was 'text'
					let contentSource = rule.contentSource;
					if (typeof rule.folderPath === 'string' && rule.contentSource === undefined) {
						contentSource = 'text';
					}
					contentSource = contentSource || 'text';
	
					const migratedRule: Rule = {
						type: type,
						contentSource: contentSource,
						footerText: rule.footerText || '',
					};
	
					if (migratedRule.type === 'folder') {
						migratedRule.path = rule.path !== undefined ? rule.path : (rule.folderPath !== undefined ? rule.folderPath : '');
					} else { // 'tag'
						migratedRule.tag = rule.tag !== undefined ? rule.tag : '';
					}
	
					if (migratedRule.contentSource === 'file') {
						migratedRule.footerFilePath = rule.footerFilePath || '';
					}
					// footerText is always present
	
					return migratedRule;
				});
			}
		}
	
		// Ensure there's at least one rule if rules array is empty after loading/migration
		if (!this.settings.rules || this.settings.rules.length === 0) {
			this.settings.rules = [{ type: 'folder', path: '', contentSource: 'text', footerText: '' }];
		} else {
			// Final cleanup pass for each rule
			this.settings.rules.forEach(rule => {
				rule.type = rule.type || 'folder'; // Should be set by now, but as a fallback
				if (rule.type === 'folder') {
					rule.path = rule.path === undefined ? '' : rule.path;
					delete rule.tag; // Ensure tag is not present for folder type
				} else { // 'tag'
					rule.tag = rule.tag === undefined ? '' : rule.tag;
					delete rule.path; // Ensure path is not present for tag type
				}
	
				rule.contentSource = rule.contentSource || 'text';
				rule.footerText = rule.footerText || ''; // Ensure footerText is always a string
	
				if (rule.contentSource === 'file') {
					rule.footerFilePath = rule.footerFilePath || '';
				} else { // 'text'
					delete rule.footerFilePath; // Ensure footerFilePath is not present for text source
				}
			});
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class VirtualFooterSettingTab extends PluginSettingTab {
	plugin: VirtualFooterPlugin;
	private allFilePaths: Set<string> | null = null;
	private allTagsCache: Set<string> | null = null;
	private allMarkdownFilesCache: Set<string> | null = null; // Cache for markdown file paths

	constructor(app: App, plugin: VirtualFooterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private generateAllFilePaths(): Set<string> {
		if (this.allFilePaths) return this.allFilePaths;
		const paths = new Set<string>(['/']);
		this.plugin.app.vault.getAllLoadedFiles().forEach(file => {
			if (file instanceof TFile && file.parent) {
				const parentPath = file.parent.isRoot() ? '/' : (file.parent.path.endsWith('/') ? file.parent.path : file.parent.path + '/');
				if (parentPath !== '/') paths.add(parentPath);
			} else if ('children' in file && file.path !== '/') {
				const folderPath = file.path.endsWith('/') ? file.path : file.path + '/';
				paths.add(folderPath);
			}
		});
		this.allFilePaths = paths;
		return paths;
	}

	private generateAllTagsInVault(): Set<string> {
		if (this.allTagsCache) return this.allTagsCache;
		const collectedTags = new Set<string>();
		const markdownFiles = this.plugin.app.vault.getMarkdownFiles();
		for (const file of markdownFiles) {
			const fileCache = this.plugin.app.metadataCache.getFileCache(file);
			if (fileCache) {
				const tagsInFile = getAllTags(fileCache);
				if (tagsInFile) {
					tagsInFile.forEach(tag => {
						collectedTags.add(tag.startsWith('#') ? tag.substring(1) : tag);
					});
				}
			}
		}
		this.allTagsCache = collectedTags;
		return collectedTags;
	}

	private generateAllMarkdownFilePaths(): Set<string> {
		if (this.allMarkdownFilesCache) return this.allMarkdownFilesCache;
		const paths = new Set<string>();
		this.plugin.app.vault.getMarkdownFiles().forEach(file => {
			paths.add(file.path);
		});
		this.allMarkdownFilesCache = paths;
		return paths;
	}
	
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.allFilePaths = null; 
		this.allTagsCache = null; 
		this.allMarkdownFilesCache = null; // Reset markdown file cache

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
		if (this.plugin.settings.rules.length === 0) { 
			// Add a default rule if none exist, ensuring new fields are present
			this.plugin.settings.rules.push({ type: 'folder', path: '', contentSource: 'text', footerText: '' });
		}

		this.plugin.settings.rules.forEach((rule, index) => {
			this.renderRuleControls(rule, index, rulesContainer);
		});

		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('Add rule')
				.setClass('virtual-footer-add-button')
				.onClick(async () => {
					// Add new rule with default new fields
					this.plugin.settings.rules.push({ type: 'folder', path: '', contentSource: 'text', footerText: '' });
					await this.plugin.saveSettings();
					this.display(); 
					this.plugin.handleActiveViewChange();
				}));
	}

	private renderRuleControls(rule: Rule, index: number, containerEl: HTMLElement) {
		const ruleDiv = containerEl.createDiv();
		ruleDiv.addClass('rule');
	
		new Setting(ruleDiv)
			.setName(`Rule ${index + 1} type`)
			.addDropdown(dropdown => dropdown
				.addOption('folder', 'Folder')
				.addOption('tag', 'Tag')
				.setValue(rule.type)
				.onChange(async (value: 'folder' | 'tag') => {
					rule.type = value;
					if (value === 'folder') {
						delete rule.tag;
						if (rule.path === undefined) rule.path = '';
					} else { // 'tag'
						delete rule.path;
						if (rule.tag === undefined) rule.tag = '';
					}
					await this.plugin.saveSettings();
					this.display(); 
					this.plugin.handleActiveViewChange();
				}));
	
		if (rule.type === 'folder') {
			new Setting(ruleDiv)
				.setName(`Folder path`)
				.setDesc('Path for the rule. Use "" for all files, "/" for root folder files, or "FolderName/" for specific folders and their subfolders.')
				.addText(text => {
					text.setPlaceholder('e.g., Meetings/, /, or leave empty for all')
						.setValue(rule.path || '')
						.onChange(async (value) => {
							rule.path = value;
							await this.plugin.saveSettings();
							this.plugin.handleActiveViewChange();
						});
					new MultiSuggest(text.inputEl, this.generateAllFilePaths(), (selectedPath) => {
						rule.path = selectedPath;
						this.plugin.saveSettings().then(() => this.plugin.handleActiveViewChange());
						text.setValue(selectedPath);
					}, this.plugin.app);
				});
		} else if (rule.type === 'tag') {
			new Setting(ruleDiv)
				.setName(`Tag value`)
				.setDesc('Tag to match (without the #).')
				.addText(text => {
					text.setPlaceholder('e.g., important or project/alpha')
						.setValue(rule.tag || '')
						.onChange(async (value) => {
							rule.tag = value.startsWith('#') ? value.substring(1) : value;
							await this.plugin.saveSettings();
							this.plugin.handleActiveViewChange();
						});
					new MultiSuggest(text.inputEl, this.generateAllTagsInVault(), (selectedTag) => {
						const normalizedTag = selectedTag.startsWith('#') ? selectedTag.substring(1) : selectedTag;
						rule.tag = normalizedTag;
						this.plugin.saveSettings().then(() => this.plugin.handleActiveViewChange());
						text.setValue(normalizedTag);
					}, this.plugin.app);
				});
		}

		// Setting for content source (Text vs File)
		new Setting(ruleDiv)
			.setName('Content source')
			.addDropdown(dropdown => dropdown
				.addOption('text', 'Direct text')
				.addOption('file', 'Markdown file')
				.setValue(rule.contentSource || 'text') // Default to 'text' if undefined
				.onChange(async (value: 'text' | 'file') => {
					rule.contentSource = value;
					if (value === 'text') {
						if (rule.footerText === undefined) rule.footerText = ''; // Ensure footerText is initialized
						delete rule.footerFilePath; // Remove file path when switching to text
					} else { // 'file'
						if (rule.footerFilePath === undefined) rule.footerFilePath = ''; // Ensure footerFilePath is initialized
					}
					await this.plugin.saveSettings();
					this.display(); // Re-render to show/hide relevant fields
					this.plugin.handleActiveViewChange();
				}));

		// Conditional setting for Footer Text or Footer File Path
		if (rule.contentSource === 'file') {
			new Setting(ruleDiv)
				.setName('Content file path')
				.setDesc('Path to the .md file to use as content.')
				.addText(text => {
					text.setPlaceholder('e.g., templates/footer.md')
						.setValue(rule.footerFilePath || '')
						.onChange(async (value) => {
							rule.footerFilePath = value;
							await this.plugin.saveSettings();
							this.plugin.handleActiveViewChange();
						});
					// Add suggester for markdown files
					new MultiSuggest(text.inputEl, this.generateAllMarkdownFilePaths(), (selectedPath) => {
						rule.footerFilePath = selectedPath;
						this.plugin.saveSettings().then(() => this.plugin.handleActiveViewChange());
						text.setValue(selectedPath);
					}, this.plugin.app);
				});
		} else { // 'text' or undefined (defaults to text)
			new Setting(ruleDiv)
				.setName(`Content text`)
				.setDesc('Markdown text to display.')
				.addTextArea(text => text
					.setPlaceholder('Enter your markdown content here...')
					.setValue(rule.footerText) // footerText should be initialized by loadSettings
					.onChange(async (value) => {
						rule.footerText = value;
						await this.plugin.saveSettings();
						this.plugin.handleActiveViewChange();
					}));
		}
	
		new Setting(ruleDiv)
			.addButton(button => button
				.setButtonText('Delete rule')
				.setClass('virtual-footer-delete-button')
				.onClick(async () => {
					this.plugin.settings.rules.splice(index, 1);
					await this.plugin.saveSettings();
					this.display();
					this.plugin.handleActiveViewChange();
				}));
	
		ruleDiv.createEl('hr');
	}
}

