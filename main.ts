import { App, Plugin, PluginSettingTab, Setting, MarkdownView, MarkdownRenderer, AbstractInputSuggest, Component, TFile } from 'obsidian';

interface VirtualFooterSettings {
	rules: { folderPath: string; footerText: string }[];
	renderLocation: 'footer' | 'header'; // New setting
}
const DEFAULT_SETTINGS: VirtualFooterSettings = {
	rules: [{ folderPath: '', footerText: '' }],
	renderLocation: 'footer' // Default to footer
}

// MultiSuggest class remains unchanged (as provided in the original code)
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

export default class VirtualFooterPlugin extends Plugin {
	settings: VirtualFooterSettings;
	
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new VirtualFooterSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on('file-open', () => 
				this.handleActiveViewChange()
			)
		);

		this.registerEvent(
			this.app.workspace.on('layout-change', () => 
				this.handleActiveViewChange()
			)
		);
		this.handleActiveViewChange();
	}

	handleActiveViewChange() {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		this._handleView(activeView); 
	}
	
	private async _handleView(view: MarkdownView | null) {
		if (!view || !view.file) {
			this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
				if (leaf.view instanceof MarkdownView) {
					this.removeStylesAndInjectedContent(leaf.view);
				}
			});
			return;
		}

		await this.removeStylesAndInjectedContent(view);

		const state = view.getState();
		const isRenderInHeader = this.settings.renderLocation === 'header';

		if (state.mode === 'source' && !state.source && !isRenderInHeader) {
			const [contentEl, containerEl] = [
				view.containerEl.querySelector('.cm-editor .cm-content'),
				view.containerEl.querySelector('.markdown-source-view.mod-cm6 .cm-contentContainer')
			] as (HTMLDivElement | null)[];
			contentEl?.classList.add('virtual-footer-cm-padding');
			containerEl?.classList.add('virtual-footer-remove-flex');
		}

		if (state.mode === 'preview' || (state.mode === 'source' && !state.source)) {
			await this.injectContent(view);
		}
	}
	
	private async injectContent(view: MarkdownView) {
		const contentText = this.getFooterTextForFile(view.file?.path || '');
		if (!contentText) {
			await this.removeInjectedContentDOM(view);
			return;
		}

		const isRenderInHeader = this.settings.renderLocation === 'header';
		const state = view.getState();
		let targetParent: Element | null = null;

		if (state.mode === 'preview') {
			targetParent = isRenderInHeader
				? view.containerEl.querySelector('.mod-header.mod-ui') // Updated for preview header
				: view.containerEl.querySelector('.mod-footer');
		} else if (state.mode === 'source' && !state.source) { // Live Preview editor
			targetParent = isRenderInHeader
				? view.containerEl.querySelector('.metadata-container .metadata-content') // Updated for editor header
				: view.containerEl.querySelector('.cm-sizer');
		}

		if (!targetParent) {
			// console.warn('VirtualFooterPlugin: Target parent for injection not found for current mode/setting.');
			return;
		}
		
		const contentDiv = document.createElement('div');
		contentDiv.className = 'dynamic-content-element';
		contentDiv.classList.add(isRenderInHeader ? 'header-rendered-content' : 'footer-rendered-content');

		const contentComponent = new class extends Component {}();
		contentComponent.load();
		(contentDiv as HTMLElement & { contentComponent?: Component }).contentComponent = contentComponent;

		await MarkdownRenderer.render(
			this.app,
			contentText,
			contentDiv,
			view.file?.path || '',
			contentComponent
		);
		
		targetParent.appendChild(contentDiv);
		this.attachInternalLinkHandlers(contentDiv, view.file?.path || '', contentComponent, view);
	}

	private attachInternalLinkHandlers(container: HTMLElement, sourcePath: string, contentComponent: Component, view: MarkdownView) {
		contentComponent.registerDomEvent(container, 'click', (event: MouseEvent) => {
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
	}

	private async removeStylesAndInjectedContent(view: MarkdownView) {
		const [content, container] = [
			view.containerEl.querySelector('.cm-editor .cm-content'),
			view.containerEl.querySelector('.markdown-source-view.mod-cm6 .cm-contentContainer')
		] as (HTMLDivElement | null)[];
		content?.classList.remove('virtual-footer-cm-padding');
		container?.classList.remove('virtual-footer-remove-flex');

		await this.removeInjectedContentDOM(view);
	}

	private async removeInjectedContentDOM(view: MarkdownView) {
		const potentialParentsSelectors = [
			'.cm-sizer',                                // Editor footer
			'.mod-footer',                              // Preview footer
			'.mod-header.mod-ui',                       // New: Preview header
			'.metadata-container .metadata-content',    // New: Editor header (beneath metadata)
			'.view-header'                              // Old header location (kept for broader cleanup)
		];

		potentialParentsSelectors.forEach(selector => {
			const parentEl = view.containerEl.querySelector(selector);
			parentEl?.querySelectorAll('.dynamic-content-element').forEach(el => {
				const componentHolder = el as HTMLElement & { contentComponent?: Component };
				if (componentHolder.contentComponent) {
					componentHolder.contentComponent.unload();
				}
				el.remove();
			});
		});
	}
	
	private getFooterTextForFile(filePath: string): string {
		let bestMatchPath = '';
		let footerText = '';
		for (const rule of this.settings.rules) {
			if (filePath.startsWith(rule.folderPath) && rule.folderPath.length >= bestMatchPath.length) {
				bestMatchPath = rule.folderPath;
				footerText = rule.footerText;
			}
		}
		return footerText;
	}
	
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	
	async saveSettings() {
		await this.saveData(this.settings);
	}

	async onunload() {
		this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
			if (leaf.view instanceof MarkdownView) {
				this.removeStylesAndInjectedContent(leaf.view);
			}
		});

		document.querySelectorAll('.dynamic-content-element').forEach(el => {
			const component = el as HTMLElement & { contentComponent?: Component };
			if (component.contentComponent) {
				component.contentComponent.unload();
			}
			el.remove();
		});

		document.querySelectorAll('.virtual-footer-cm-padding').forEach(el => el.classList.remove('virtual-footer-cm-padding'));
		document.querySelectorAll('.virtual-footer-remove-flex').forEach(el => el.classList.remove('virtual-footer-remove-flex'));
	}
}

// VirtualFooterSettingTab class remains unchanged (as provided in the original code)
class VirtualFooterSettingTab extends PluginSettingTab {
	plugin: VirtualFooterPlugin;
	
	constructor(app: App, plugin: VirtualFooterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	
	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Render location')
			.setDesc('Choose where to render the content in the view.')
			.addDropdown(dropdown => dropdown
				.addOption('footer', 'Footer')
				.addOption('header', 'Header (Bottom)')
				.setValue(this.plugin.settings.renderLocation)
				.onChange(async (value: 'footer' | 'header') => {
					this.plugin.settings.renderLocation = value;
					await this.plugin.saveSettings();
					this.plugin.handleActiveViewChange(); 
				}));
		
		const rulesContainer = containerEl.createDiv();
		rulesContainer.addClass('rules-container');

		const renderRules = () => {
			rulesContainer.empty();
			if (!this.plugin.settings.rules) {
				this.plugin.settings.rules = [];
			}
			this.plugin.settings.rules.forEach((rule, index) => {
				const ruleDiv = rulesContainer.createDiv();
				ruleDiv.addClass('rule');

				new Setting(ruleDiv)
					.setName(`Folder path ${index + 1}`)
					.setDesc('Path in the vault. Content will apply to notes in this folder and its subfolders. Use "/" for all notes.')
					.addText(text => {
						const allFilePaths = new Set<string>(['/']);
						this.plugin.app.vault.getAllLoadedFiles().forEach(file => {
							if (file instanceof TFile && file.parent) {
								allFilePaths.add(file.parent.path === '/' ? '/' : file.parent.path + '/');
							} else if ('children' in file && file.path !== '/') { // TFolder
								allFilePaths.add(file.path + '/');
							}
						});

						text.setPlaceholder('e.g., Meetings/ or /')
							.setValue(rule.folderPath)
							.onChange(async (value) => {
								this.plugin.settings.rules[index].folderPath = value;
								await this.plugin.saveSettings();
								this.plugin.handleActiveViewChange();
							});
						new MultiSuggest(text.inputEl, allFilePaths, (selectedPath) => {
							this.plugin.settings.rules[index].folderPath = selectedPath;
							this.plugin.saveSettings();
							this.plugin.handleActiveViewChange();
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
							renderRules(); 
							this.plugin.handleActiveViewChange();
						}));

				const divider = document.createElement('hr');
				ruleDiv.appendChild(divider);
			});
		};

		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('Add rule')
				.setClass('virtual-footer-add-button')
				.onClick(async () => {
					this.plugin.settings.rules.push({ folderPath: '', footerText: '' });
					await this.plugin.saveSettings();
					renderRules();
				}));

		renderRules();
	}
}
