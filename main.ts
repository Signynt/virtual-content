import { App, Plugin, PluginSettingTab, Setting, MarkdownView, MarkdownRenderer, AbstractInputSuggest, Component } from 'obsidian';

interface VirtualFooterSettings {
	rules: { folderPath: string; footerText: string }[];
}
const DEFAULT_SETTINGS: VirtualFooterSettings = {
	rules: [{ folderPath: '', footerText: '' }]
}

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

		//Take care of the footer when the view changes
		const handleView = async (view: MarkdownView | null) => {
			if (!view?.file) return;
			const state = view.getState();
			
			if (state.mode === 'preview') {
				await this.injectFooterToPreview(view);
			} else if (state.mode === 'source' && !state.source) {
				// Remove the padding from the content area to append the footer
				const [content, container] = [
					view.containerEl.querySelector('.cm-editor .cm-content'),
					view.containerEl.querySelector('.markdown-source-view.mod-cm6 .cm-contentContainer')
				] as HTMLDivElement[];
				content?.classList.add('virtual-footer-cm-padding');
				container?.classList.add('virtual-footer-remove-flex');

				await this.injectFooterToEditor(view);
			} else {
				// Remove the custom styling from the content area
				const [content, container] = [
					view.containerEl.querySelector('.cm-editor .cm-content'),
					view.containerEl.querySelector('.markdown-source-view.mod-cm6 .cm-contentContainer')
				] as HTMLDivElement[];
				content?.classList.remove('virtual-footer-cm-padding');
				container?.classList.remove('virtual-footer-remove-flex');

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
		
		const footerComponent = new class extends Component {}();
		footerComponent.load();

		await MarkdownRenderer.render(
			this.app,
			footerText,
			footerDiv,
			view.file?.path || '',
			footerComponent
		);

        (footerDiv as HTMLElement & { footerComponent?: Component }).footerComponent = footerComponent;
		
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
		
		const footerComponent = new class extends Component {}();
		footerComponent.load();

		await MarkdownRenderer.render(
			this.app,
			footerText,
			footerDiv,
			view.file?.path || '',
			footerComponent
		);

		(footerDiv as HTMLElement & { footerComponent?: Component }).footerComponent = footerComponent;

		// Get the content container and append the footer at the bottom
		cmEditor.appendChild(footerDiv);

		// Re-register all internal link click behaviors manually
		this.attachInternalLinkHandlers(footerDiv, view.file?.path || '', footerComponent, view);
	}

	// Manually attach internal link handlers to the footer since they don't work natively, this is a workaround for now
	private attachInternalLinkHandlers(container: HTMLElement, sourcePath: string, footerComponent: Component, view: MarkdownView) {
		// Register click handler for internal links using the component
		footerComponent.registerDomEvent(container, 'click', (event: MouseEvent) => {
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

    async onunload() {
        // Remove all footers from the document
        document.querySelectorAll('.virtual-footer').forEach(footer => {
            const component = footer as HTMLElement & { footerComponent?: Component };
            if (component.footerComponent) {
                // Unload the component associated with this footer
                component.footerComponent.unload();
            }
            footer.remove();
        });

        // Remove custom styling applied to editor elements
        document.querySelectorAll('.virtual-footer-cm-padding').forEach(el => el.classList.remove('virtual-footer-cm-padding'));
        document.querySelectorAll('.virtual-footer-remove-flex').forEach(el => el.classList.remove('virtual-footer-remove-flex'));
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
					.setName(`Folder path ${index + 1}`)
					.setDesc('Path in the vault where footer should be displayed')
					.addText(text => text
						.setPlaceholder('')
						.setValue(rule.folderPath)
						.onChange(async (value) => {
							new MultiSuggest(text.inputEl, new Set(this.plugin.app.vault.getAllLoadedFiles().map(file => file.path)), async (value) => {
								this.plugin.settings.rules[index].folderPath = value;
								await this.plugin.saveSettings();
							}, this.plugin.app);
							this.plugin.settings.rules[index].folderPath = value;
							await this.plugin.saveSettings();
						}));

				new Setting(ruleDiv)
					.setName(`Footer text ${index + 1}`)
					.setDesc('Markdown text to display in the footer')
					.addTextArea(text => text
						.setPlaceholder('Enter your footer text here...')
						.setValue(rule.footerText)
						.onChange(async (value) => {
							this.plugin.settings.rules[index].footerText = value;
							await this.plugin.saveSettings();
						}));

				new Setting(ruleDiv)
					.addButton(button => button
						.setButtonText('Delete rule')
						.setClass('virtual-footer-delete-button')
						.onClick(async () => {
							this.plugin.settings.rules.splice(index, 1);
							await this.plugin.saveSettings();
							renderRules();
						}));

				// Add a visual divider
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