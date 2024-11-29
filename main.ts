import { App, Plugin, PluginSettingTab, Setting, MarkdownView, MarkdownRenderer } from 'obsidian';

interface DynamicFooterSettings {
	rules: { folderPath: string; footerText: string }[];
}
const DEFAULT_SETTINGS: DynamicFooterSettings = {
	rules: [{ folderPath: '', footerText: '' }]
}

export default class DynamicFooterPlugin extends Plugin {
	settings: DynamicFooterSettings;
	
	async onload() {
		await this.loadSettings();
		
		// Add settings tab
		this.addSettingTab(new DynamicFooterSettingTab(this.app, this));
		
		// Register event to handle file open
		this.registerEvent(
			this.app.workspace.on('file-open', async (file) => {
				if (!file) return;
				
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return;
				
				// Handle both reading and editing modes
				if (view.getMode() === 'preview') {
					this.injectFooterToPreview(view);
				} else {
					this.injectFooterToEditor(view);
				}
			})
		);
		
		// Register event for layout change (switching between preview/edit modes)
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return;
				
				const file = view.file;
				if (!file) return;
				
				if (view.getMode() === 'preview') {
					this.injectFooterToPreview(view);
				} else {
					this.injectFooterToEditor(view);
				}
			})
		);
	}
	
	private async injectFooterToPreview(view: MarkdownView) {
		const container = view.containerEl.querySelector('.mod-footer');
		if (!container) return;
		
		// Remove existing footer if any
		const existingFooter = container.querySelector('.dynamic-footer');
		if (existingFooter) existingFooter.remove();
		
		// Determine the appropriate footer text based on the file path
		const footerText = this.getFooterTextForFile(view.file?.path || '');
		
		// Create and inject new footer as a widget below the editor
		const footerDiv = document.createElement('div');
		footerDiv.className = 'dynamic-footer';
		
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
		const cmEditor = view.containerEl.querySelector('.cm-editor');
		if (!cmEditor) return;
		
		// Remove existing footer if any
		const existingFooter = cmEditor.querySelector('.dynamic-footer');
		if (existingFooter) existingFooter.remove();
		
		// Determine the appropriate footer text based on the file path
		const footerText = this.getFooterTextForFile(view.file?.path || '');
		
		// Create and inject new footer as a widget below the editor
		const footerDiv = document.createElement('div');
		footerDiv.className = 'dynamic-footer';
		//footerDiv.style.marginInline = 'var(--content-margin)';
		
		await MarkdownRenderer.render(
			this.app,
			footerText,
			footerDiv,
			view.file?.path || '',
			this
		);

		// Get the content container and append the footer at the bottom
		const content = cmEditor.querySelector('.cm-sizer');
		if (content) {
			content.appendChild(footerDiv);
		}
	}
	
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

class DynamicFooterSettingTab extends PluginSettingTab {
	plugin: DynamicFooterPlugin;
	
	constructor(app: App, plugin: DynamicFooterPlugin) {
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