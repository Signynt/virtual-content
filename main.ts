import { App, Plugin, PluginSettingTab, Setting, MarkdownView, MarkdownRenderer, MarkdownPreviewView } from 'obsidian';

interface VirtualFooterSettings {
	rules: { folderPath: string; footerText: string }[];
}
const DEFAULT_SETTINGS: VirtualFooterSettings = {
	rules: [{ folderPath: '', footerText: '' }]
}

export default class VirtualFooterPlugin extends Plugin {
	settings: VirtualFooterSettings;
	
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new VirtualFooterSettingTab(this.app, this));

		//Take care of the footer when the view changes
		const handleView = async (view: MarkdownView | null) => {
			if (!view?.file) return;
			const state = view.getState();
			
			if (state.mode === 'preview') {
				await this.injectFooterToPreview(view);
			} else if (state.mode === 'source' && !state.source) {
				// Remove the padding from the content area to append the footer
				const cmContent = view.containerEl.querySelector('.cm-editor .cm-content') as HTMLDivElement;
				if (cmContent) {
					cmContent.classList.add('virtual-footer-cm-padding');
				}
				await this.injectFooterToEditor(view);
			} else {
				// Remove the custom styling from the content area
				const cmContent = view.containerEl.querySelector('.cm-editor .cm-content') as HTMLDivElement;
				if (cmContent) {
					cmContent.classList.remove('virtual-footer-cm-padding');
				}
				await this.removeFooter(view);
			}
		};

		// Handle the view when a file is opened
		this.registerEvent(
			this.app.workspace.on('file-open', () => 
				handleView(this.app.workspace.getActiveViewOfType(MarkdownView))
			)
		);

		// Handle the view when a file layout changes
		this.registerEvent(
			this.app.workspace.on('layout-change', () => 
				handleView(this.app.workspace.getActiveViewOfType(MarkdownView))
			)
		);
	}
	
	private async injectFooterToPreview(view: MarkdownView) {
		const container = view.containerEl.querySelector('.mod-footer');
		if (!container) return;
		
		// Remove existing footer if any
		const existingFooter = container.querySelector('.virtual-footer');
		if (existingFooter) existingFooter.remove();
		
		// Determine the appropriate footer text based on the file path
		const footerText = this.getFooterTextForFile(view.file?.path || '');
		
		// Create and inject new footer as a widget below the editor
		const footerDiv = document.createElement('div');
		footerDiv.className = 'virtual-footer';
		
		await MarkdownRenderer.render(
			this.app,
			footerText,
			footerDiv,
			view.file?.path || '',
			this
		);
		
		container.appendChild(footerDiv);
	}
	
	private async injectFooterToEditor(view: MarkdownView) {
		const cmEditor = view.containerEl.querySelector('.cm-sizer');
		if (!cmEditor) return;
		
		// Remove existing footer if any
		const existingFooter = cmEditor.querySelector('.virtual-footer');
		if (existingFooter) existingFooter.remove();
		
		// Determine the appropriate footer text based on the file path
		const footerText = this.getFooterTextForFile(view.file?.path || '');
		
		// Create and inject new footer as a widget below the editor
		const footerDiv = document.createElement('div');
		footerDiv.className = 'virtual-footer';
		footerDiv.style.minHeight = '528px';
		
		await MarkdownRenderer.render(
			this.app,
			footerText,
			footerDiv,
			view.file?.path || '',
			this
		);

		// Get the content container and append the footer at the bottom
		cmEditor.appendChild(footerDiv);

		// Re-register all internal link click behaviors manually
		this.attachInternalLinkHandlers(footerDiv, view.file?.path || '');
	}

	// Manually attach internal link handlers to the footer since they don't work natively, this is a workaround for now
	private attachInternalLinkHandlers(container: HTMLElement, sourcePath: string) {
		container.querySelectorAll('a.internal-link').forEach(link => {
			const handleClick = (event: MouseEvent, forceNewLeaf = false) => {
				event.preventDefault();
				const href = link.getAttribute('href');
				const target = href && this.app.metadataCache.getFirstLinkpathDest(href, sourcePath);
				if (target) {
					this.app.workspace.getLeaf(forceNewLeaf || event.ctrlKey || event.metaKey)
						.openFile(target);
				}
			};

			link.addEventListener('click', handleClick);
			link.addEventListener('auxclick', (e: MouseEvent) => e.button === 1 && handleClick(e, true));
		});
	}

	private async removeFooter(view: MarkdownView) {
		const cmEditor = view.containerEl.querySelector('.cm-sizer');
		if (!cmEditor) return;
		
		const selectors = ['.cm-sizer', '.mod-footer'].map(s => view.containerEl.querySelector(s));
		selectors.forEach(el => el?.querySelector('.virtual-footer')?.remove());
	}
	
	// Get the footer text for a given file path based on the rules
	private getFooterTextForFile(filePath: string): string {
		for (const rule of this.settings.rules) {
			if (filePath.startsWith(rule.folderPath)) {
				return rule.footerText;
			}
		}
		return '';
	}
	
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	
	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class VirtualFooterSettingTab extends PluginSettingTab {
	plugin: VirtualFooterPlugin;
	
	constructor(app: App, plugin: VirtualFooterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	
	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		
		const rulesContainer = containerEl.createDiv();
		rulesContainer.addClass('rules-container');

		const renderRules = () => {
			rulesContainer.empty();
			this.plugin.settings.rules.forEach((rule, index) => {
				const ruleDiv = rulesContainer.createDiv();
				ruleDiv.addClass('rule');

				new Setting(ruleDiv)
					.setName(`Folder Path ${index + 1}`)
					.setDesc('Path in the vault where footer should be displayed')
					.addText(text => text
						.setPlaceholder('')
						.setValue(rule.folderPath)
						.onChange(async (value) => {
							this.plugin.settings.rules[index].folderPath = value;
							await this.plugin.saveSettings();
						}));

				new Setting(ruleDiv)
					.setName(`Footer Text ${index + 1}`)
					.setDesc('Markdown text to display in the footer')
					.addTextArea(text => text
						.setPlaceholder('Enter your footer text here...')
						.setValue(rule.footerText)
						.onChange(async (value) => {
							this.plugin.settings.rules[index].footerText = value;
							await this.plugin.saveSettings();
						}));

				const deleteButton = document.createElement('button');
				deleteButton.textContent = 'Delete Rule';
				deleteButton.style.margin = '1em';
				deleteButton.addEventListener('click', async () => {
					this.plugin.settings.rules.splice(index, 1);
					await this.plugin.saveSettings();
					renderRules();
				});
				ruleDiv.appendChild(deleteButton);

				// Add a visual divider
				const divider = document.createElement('hr');
				divider.style.margin = '1em 0';
				ruleDiv.appendChild(divider);
			});
		};

		const addButton = document.createElement('button');
		addButton.textContent = 'Add Rule';
		addButton.style.margin = '1em';
		addButton.style.float = 'right';
		addButton.addEventListener('click', async () => {
			this.plugin.settings.rules.push({ folderPath: '', footerText: '' });
			await this.plugin.saveSettings();
			renderRules();
		});
		containerEl.appendChild(addButton);

		renderRules();
	}
}