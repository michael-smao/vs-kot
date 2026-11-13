/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the Tab Completion view in the side bar. See ../common/tabCompletion.ts for where its content comes from.

import './media/tabCompletion.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { ISelectOptionItem, SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles, defaultProgressBarStyles, defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { describeTabCompletionStatus, ITabCompletionDescription, ITabCompletionStatus, ITabCompletionStatusService, TAB_COMPLETION_VIEW_ID, TabCompletionAction, TabCompletionExtensionCommandId, TabCompletionHealth, TabCompletionSetting } from '../common/tabCompletion.js';
import { formatTabCompletionAcceptRate, formatTabCompletionCount, formatTabCompletionDay, ITabCompletionUsage, ITabCompletionUsageCounts } from '../common/tabCompletionUsage.js';

interface IButtonDescription {
	readonly label: string;
	readonly primary: boolean;
	readonly run: () => void;
}

/** One line of the statistics: what is counted, and how a count of it reads. */
interface IUsageRow {
	readonly name: string;
	readonly description: string;
	readonly format: (counts: ITabCompletionUsageCounts) => string;
}

/** The spans of time the statistics are shown for, one column each. */
const usageSpans: readonly (keyof Omit<ITabCompletionUsage, 'since'>)[] = ['today', 'week', 'total'];

/** One entry of the model list. `undefined` as value stands for "ask for a name". */
interface IModelOption {
	readonly item: ISelectOptionItem;
	readonly value?: string;
}

export class TabCompletionView extends ViewPane {

	static readonly ID = TAB_COMPLETION_VIEW_ID;

	private content: HTMLElement | undefined;
	private headlineIcon!: HTMLElement;
	private headlineTitle!: HTMLElement;
	private detail!: HTMLElement;
	private progress!: ProgressBar;
	private statusButtons!: HTMLElement;
	private modelSection!: HTMLElement;
	private modelSelect!: HTMLElement;
	private modelHint!: HTMLElement;
	private serverSection!: HTMLElement;
	private serverRows!: HTMLElement;
	private serverButtons!: HTMLElement;
	private usageSection!: HTMLElement;
	/** The cells of the statistics that hold numbers, line by line. */
	private usageCells: { readonly row: IUsageRow; readonly cells: readonly HTMLElement[] }[] = [];
	private usageHint!: HTMLElement;

	// Buttons and the model list are only built anew when what they show changes. While a download reports
	// its progress several times a second, they stay as they are and can be used.
	private readonly statusButtonsStore = this._register(new DisposableStore());
	private statusButtonsKey: string | undefined;
	private readonly serverButtonsStore = this._register(new DisposableStore());
	private serverButtonsKey: string | undefined;
	private readonly modelSelectStore = this._register(new DisposableStore());
	private modelSelectKey: string | undefined;

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ITabCompletionStatusService private readonly statusService: ITabCompletionStatusService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('tab-completion-view');
		const body = this.content = append(container, $('.tab-completion-body'));

		const headline = append(body, $('.tab-completion-headline'));
		this.headlineIcon = append(headline, $('span.tab-completion-headline-icon'));
		this.headlineTitle = append(headline, $('span.tab-completion-headline-title'));
		this.detail = append(body, $('.tab-completion-detail'));
		this.progress = this._register(new ProgressBar(append(body, $('.tab-completion-progress')), defaultProgressBarStyles));
		this.progress.hide();
		this.statusButtons = append(body, $('.tab-completion-buttons'));

		this.modelSection = append(body, $('.tab-completion-section'));
		append(this.modelSection, $('h3.tab-completion-heading')).textContent = localize('model', "Model");
		this.modelSelect = append(this.modelSection, $('.tab-completion-select'));
		this.modelHint = append(this.modelSection, $('.tab-completion-hint'));

		this.serverSection = append(body, $('.tab-completion-section'));
		append(this.serverSection, $('h3.tab-completion-heading')).textContent = localize('modelServer', "Model Server");
		this.serverRows = append(this.serverSection, $('.tab-completion-rows'));
		this.serverButtons = append(this.serverSection, $('.tab-completion-buttons'));

		this.usageSection = append(body, $('.tab-completion-section'));
		append(this.usageSection, $('h3.tab-completion-heading')).textContent = localize('statistics', "Statistics");
		this.renderUsageTable(append(this.usageSection, $('table.tab-completion-usage')));
		this.usageHint = append(this.usageSection, $('.tab-completion-hint'));

		this._register(this.statusService.onDidChangeStatus(() => this.update()));
		this._register(this.statusService.onDidChangeUsage(() => this.updateUsage()));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.requestStatus();
			}
		}));

		this.update();
		this.updateUsage();
		this.requestStatus();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.content) {
			this.content.style.height = `${height}px`;
		}
	}

	/**
	 * Asks the extension to look at its model server again, and for how much it was used: other windows count too.
	 * Not an error if the extension is not there yet.
	 */
	private requestStatus(): void {
		this.commandService.executeCommand(TabCompletionExtensionCommandId.RequestStatus).then(undefined, () => undefined);
		this.commandService.executeCommand(TabCompletionExtensionCommandId.RequestUsage).then(undefined, () => undefined);
	}

	private runExtensionCommand(id: TabCompletionExtensionCommandId): void {
		this.commandService.executeCommand(id).then(undefined, error => this.notificationService.error(error));
	}

	private update(): void {
		const status = this.statusService.status;
		const description = describeTabCompletionStatus(status);

		this.headlineIcon.className = `tab-completion-headline-icon ${description.health} ${ThemeIcon.asClassName(this.getHeadlineIcon(status, description))}`;
		this.headlineTitle.textContent = description.title;
		this.detail.textContent = description.detail;

		if (!description.busy) {
			this.progress.stop().hide();
		} else if (status?.state === 'settingUp' && status.percent !== undefined) {
			this.progress.total(100).setWorked(status.percent).show();
		} else {
			this.progress.infinite().show();
		}

		this.renderButtons(this.statusButtons, this.statusButtonsStore, description.actions.map((action, index) => this.toButton(action, index === 0 && action !== TabCompletionAction.TurnOff)), 'statusButtonsKey');

		this.modelSection.classList.toggle('hidden', !status);
		this.serverSection.classList.toggle('hidden', !status);
		if (status) {
			this.renderModel(status);
			this.renderServer(status, description);
		}
	}

	private getHeadlineIcon(status: ITabCompletionStatus | undefined, description: ITabCompletionDescription): ThemeIcon {
		if (description.busy) {
			return ThemeIcon.modify(Codicon.loading, 'spin');
		}
		switch (description.health) {
			case TabCompletionHealth.Good: return Codicon.passFilled;
			case TabCompletionHealth.Problem: return Codicon.error;
			case TabCompletionHealth.Neutral: return status?.enabled === false ? Codicon.circleSlash : Codicon.circleLarge;
		}
	}

	private toButton(action: TabCompletionAction, primary: boolean): IButtonDescription {
		switch (action) {
			case TabCompletionAction.SetUp:
				return { label: localize('setUp', "Set Up"), primary, run: () => this.runExtensionCommand(TabCompletionExtensionCommandId.SetUp) };
			case TabCompletionAction.Start:
				return { label: localize('start', "Start"), primary, run: () => this.runExtensionCommand(TabCompletionExtensionCommandId.SetUp) };
			case TabCompletionAction.TryAgain:
				return { label: localize('tryAgain', "Try Again"), primary, run: () => this.runExtensionCommand(TabCompletionExtensionCommandId.SetUp) };
			case TabCompletionAction.TurnOn:
				return { label: localize('turnOn', "Turn On"), primary, run: () => this.runExtensionCommand(TabCompletionExtensionCommandId.Toggle) };
			case TabCompletionAction.TurnOff:
				return { label: localize('turnOff', "Turn Off"), primary, run: () => this.runExtensionCommand(TabCompletionExtensionCommandId.Toggle) };
			case TabCompletionAction.OpenSettings:
				return { label: localize('openSettings', "Open Settings"), primary, run: () => this.preferencesService.openSettings({ query: 'tabCompletion' }) };
		}
	}

	private renderButtons(container: HTMLElement, store: DisposableStore, buttons: readonly IButtonDescription[], keyProperty: 'statusButtonsKey' | 'serverButtonsKey'): void {
		const key = buttons.map(button => `${button.primary ? '!' : ''}${button.label}`).join('|');
		if (this[keyProperty] === key) {
			return;
		}
		this[keyProperty] = key;

		store.clear();
		clearNode(container);
		container.classList.toggle('hidden', buttons.length === 0);
		for (const description of buttons) {
			const button = store.add(new Button(container, { ...defaultButtonStyles, secondary: !description.primary }));
			button.label = description.label;
			store.add(button.onDidClick(() => description.run()));
		}
	}

	// --- model

	private renderModel(status: ITabCompletionStatus): void {
		const installed = status.installedModels.find(model => model.name === status.model);
		if (status.isModelAutomatic) {
			this.modelHint.textContent = localize('model.automatic.hint', "The editor picks a model that fits the memory of this computer.");
		} else if (installed?.size !== undefined) {
			this.modelHint.textContent = localize('model.size.hint', "{0} on disk.", formatSize(installed.size));
		} else if (!installed && status.server === 'managed') {
			this.modelHint.textContent = localize('model.missing.hint', "Not on this computer yet. Set Up downloads it.");
		} else {
			this.modelHint.textContent = '';
		}

		const options = this.getModelOptions(status);
		const selected = Math.max(0, options.findIndex(option => status.isModelAutomatic ? option.value === '' : option.value === status.model));
		const key = JSON.stringify([options.map(option => [option.item.text, option.item.decoratorRight]), selected]);
		if (this.modelSelectKey === key) {
			return;
		}
		this.modelSelectKey = key;

		this.modelSelectStore.clear();
		clearNode(this.modelSelect);
		const selectBox = this.modelSelectStore.add(new SelectBox(options.map(option => option.item), selected, this.contextViewService, defaultSelectBoxStyles, { useCustomDrawn: true, ariaLabel: localize('model.aria', "Model for Tab Completion") }));
		selectBox.render(this.modelSelect);
		this.modelSelectStore.add(selectBox.onDidSelect(e => {
			const option = options[e.index];
			if (option.value === undefined) {
				selectBox.select(selected);
				this.askForModel(status.model);
			} else if (e.index !== selected) {
				this.setModel(option.value);
			}
		}));
	}

	private getModelOptions(status: ITabCompletionStatus): IModelOption[] {
		const options: IModelOption[] = [{
			item: { text: status.isModelAutomatic ? localize('model.automatic.current', "Automatic ({0})", status.model) : localize('model.automatic', "Automatic") },
			value: ''
		}];

		for (const model of status.installedModels) {
			options.push({ item: { text: model.name, decoratorRight: model.size === undefined ? undefined : formatSize(model.size) }, value: model.name });
		}
		if (!status.isModelAutomatic && !status.installedModels.some(model => model.name === status.model)) {
			options.push({ item: { text: status.model, decoratorRight: status.server === 'managed' ? localize('model.notDownloaded', "Not Downloaded") : undefined }, value: status.model });
		}

		options.push({ item: { text: localize('model.other', "Other Model...") } });
		return options;
	}

	private async askForModel(current: string): Promise<void> {
		const name = await this.quickInputService.input({
			title: localize('model.other.title', "Model for Tab Completion"),
			prompt: localize('model.other.prompt', "Name of a code model that can fill in the middle of a file, as the model server knows it."),
			placeHolder: localize('model.other.placeholder', "For example {0}", 'qwen2.5-coder:1.5b-base'),
			value: current
		});
		if (name?.trim()) {
			this.setModel(name.trim());
		}
	}

	private setModel(name: string): void {
		this.configurationService.updateValue(TabCompletionSetting.Model, name).then(undefined, error => this.notificationService.error(error));
	}

	// --- model server

	private renderServer(status: ITabCompletionStatus, description: ITabCompletionDescription): void {
		const rows: [string, string][] = [
			[localize('server.runsOn', "Runs on"), status.server === 'managed' ? localize('server.managed', "This computer, started by the editor") : localize('server.external', "A server from the settings")],
			[localize('server.address', "Address"), status.endpoint],
			[localize('server.state', "State"), description.serverState]
		];
		if (status.installedModels.length > 0) {
			rows.push([localize('server.models', "Models"), status.installedModels.map(model => model.name).join(', ')]);
		}

		clearNode(this.serverRows);
		for (const [name, value] of rows) {
			const row = append(this.serverRows, $('.tab-completion-row'));
			append(row, $('span.tab-completion-row-name')).textContent = name;
			append(row, $('span.tab-completion-row-value')).textContent = value;
		}

		const canStop = status.server === 'managed' && (status.state === 'ready' || status.state === 'starting');
		this.renderButtons(this.serverButtons, this.serverButtonsStore, canStop ? [{
			label: localize('server.stop', "Stop Model Server"),
			primary: false,
			run: () => this.runExtensionCommand(TabCompletionExtensionCommandId.StopServer)
		}] : [], 'serverButtonsKey');
	}

	// --- statistics

	/** The table is built once. What changes later is only the numbers in it. */
	private renderUsageTable(table: HTMLElement): void {
		const rows: IUsageRow[] = [
			{ name: localize('usage.shown', "Suggestions"), description: localize('usage.shown.description', "Suggestions that appeared in the editor."), format: counts => formatTabCompletionCount(counts.shown) },
			{ name: localize('usage.accepted', "Accepted"), description: localize('usage.accepted.description', "Suggestions that Tab accepted, in whole or word by word."), format: counts => formatTabCompletionCount(counts.accepted) },
			{ name: localize('usage.rate', "Accept Rate"), description: localize('usage.rate.description', "The share of the suggestions that were accepted."), format: formatTabCompletionAcceptRate },
			{ name: localize('usage.lines', "Lines Written"), description: localize('usage.lines.description', "Lines of code that accepted suggestions wrote. A line that a suggestion only finished counts as one."), format: counts => formatTabCompletionCount(counts.lines) },
			{ name: localize('usage.characters', "Characters"), description: localize('usage.characters.description', "Characters that accepted suggestions wrote."), format: counts => formatTabCompletionCount(counts.characters) }
		];
		const spanNames: Record<typeof usageSpans[number], string> = {
			today: localize('usage.today', "Today"),
			week: localize('usage.week', "7 Days"),
			total: localize('usage.total', "All Time")
		};

		const head = append(append(table, $('thead')), $('tr'));
		append(head, $('td'));
		for (const span of usageSpans) {
			append(head, $('th.tab-completion-usage-number', { scope: 'col' })).textContent = spanNames[span];
		}

		const body = append(table, $('tbody'));
		for (const row of rows) {
			const line = append(body, $('tr'));
			const name = append(line, $('th.tab-completion-usage-name', { scope: 'row' }));
			name.textContent = row.name;
			this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), name, row.description));
			this.usageCells.push({ row, cells: usageSpans.map(() => append(line, $('td.tab-completion-usage-number'))) });
		}
	}

	private updateUsage(): void {
		const usage = this.statusService.usage;
		this.usageSection.classList.toggle('hidden', !usage);
		if (!usage) {
			return;
		}

		for (const { row, cells } of this.usageCells) {
			usageSpans.forEach((span, index) => cells[index].textContent = row.format(usage[span]));
		}
		this.usageHint.textContent = localize('usage.hint', "Counted since {0}. The numbers stay on this computer.", formatTabCompletionDay(usage.since));
	}
}

function formatSize(bytes: number): string {
	return localize('size.gigabytes', "{0} GB", (bytes / 1e9).toFixed(1));
}
