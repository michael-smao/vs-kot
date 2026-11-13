/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the Tab Completion view and its activity bar icon. See ../common/tabCompletion.ts.

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { getTabCompletionHealth, ITabCompletionStatusService, parseTabCompletionStatus, ReportTabCompletionStatusCommandId, TAB_COMPLETION_VIEW_CONTAINER_ID, TAB_COMPLETION_VIEW_ID, TabCompletionExtensionCommandId, TabCompletionHealth, TabCompletionStatusService } from '../common/tabCompletion.js';
import { parseTabCompletionUsage, ReportTabCompletionUsageCommandId } from '../common/tabCompletionUsage.js';
import { TabCompletionView } from './tabCompletionView.js';

registerSingleton(ITabCompletionStatusService, TabCompletionStatusService, InstantiationType.Delayed);

// --- what the extension reports

CommandsRegistry.registerCommand(ReportTabCompletionStatusCommandId, (accessor, value: unknown) => {
	const status = parseTabCompletionStatus(value);
	if (status) {
		accessor.get(ITabCompletionStatusService).report(status);
	}
});

CommandsRegistry.registerCommand(ReportTabCompletionUsageCommandId, (accessor, value: unknown) => {
	const usage = parseTabCompletionUsage(value);
	if (usage) {
		accessor.get(ITabCompletionStatusService).reportUsage(usage);
	}
});

// --- view

// The icon's name ends up as the CSS class `codicon-tab-completion-view-icon`, which media/tabCompletion.css colours
const tabCompletionViewIcon = registerIcon('tab-completion-view-icon', Codicon.keyboardTab, localize('tabCompletionViewIcon', "View icon of the Tab Completion view."));

const viewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: TAB_COMPLETION_VIEW_CONTAINER_ID,
	title: localize2('tabCompletion', "Tab Completion"),
	icon: tabCompletionViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [TAB_COMPLETION_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: TAB_COMPLETION_VIEW_CONTAINER_ID,
	// After Search and Explorer, before Source Control. Which icons show at all is in vsKotActivityBar.ts
	order: 1.5,
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: TAB_COMPLETION_VIEW_ID,
	name: localize2('tabCompletion', "Tab Completion"),
	containerIcon: tabCompletionViewIcon,
	ctorDescriptor: new SyncDescriptor(TabCompletionView),
	canToggleVisibility: false,
	canMoveView: true,
}], viewContainer);

// --- view title

const whenInView = ContextKeyExpr.equals('view', TAB_COMPLETION_VIEW_ID);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'tabCompletion.view.refresh',
			title: localize2('refresh', "Refresh"),
			icon: Codicon.refresh,
			menu: { id: MenuId.ViewTitle, when: whenInView, group: 'navigation', order: 1 }
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		await Promise.all([
			commandService.executeCommand(TabCompletionExtensionCommandId.RequestStatus),
			commandService.executeCommand(TabCompletionExtensionCommandId.RequestUsage)
		]);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'tabCompletion.view.showLog',
			title: localize2('showLog', "Show Log"),
			icon: Codicon.output,
			menu: { id: MenuId.ViewTitle, when: whenInView, group: 'navigation', order: 2 }
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(TabCompletionExtensionCommandId.ShowLog);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'tabCompletion.view.openSettings',
			title: localize2('openSettings', "Open Settings"),
			icon: Codicon.settingsGear,
			menu: { id: MenuId.ViewTitle, when: whenInView, group: 'navigation', order: 3 }
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IPreferencesService).openSettings({ query: 'tabCompletion' });
	}
});

// In the "..." menu of the view, and in the command palette
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'tabCompletion.resetStatistics',
			title: localize2('resetStatistics', "Reset Statistics"),
			category: localize2('tabCompletion', "Tab Completion"),
			f1: true,
			menu: { id: MenuId.ViewTitle, when: whenInView, group: '1_statistics' }
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const { confirmed } = await accessor.get(IDialogService).confirm({
			message: localize('resetStatistics.confirm', "Reset the statistics of Tab Completion?"),
			detail: localize('resetStatistics.detail', "The counts of shown and accepted suggestions start again at zero."),
			primaryButton: localize({ key: 'resetStatistics.button', comment: ['&& denotes a mnemonic'] }, "&&Reset")
		});
		if (confirmed) {
			await commandService.executeCommand(TabCompletionExtensionCommandId.ResetUsage);
		}
	}
});

// --- activity bar icon colour

/**
 * Puts a class on the workbench that says how tab completion is doing. The stylesheet of the view turns that
 * into the colour of the view's icon in the activity bar.
 */
class TabCompletionHealthIndicator extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vsKotTabCompletionHealthIndicator';

	constructor(
		@ITabCompletionStatusService private readonly statusService: ITabCompletionStatusService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();

		this._register(this.statusService.onDidChangeStatus(() => this.update()));
		this.update();
	}

	private update(): void {
		const health = getTabCompletionHealth(this.statusService.status);
		const classList = this.layoutService.mainContainer.classList;
		classList.toggle('tab-completion-good', health === TabCompletionHealth.Good);
		classList.toggle('tab-completion-problem', health === TabCompletionHealth.Problem);
	}
}

registerWorkbenchContribution2(TabCompletionHealthIndicator.ID, TabCompletionHealthIndicator, WorkbenchPhase.AfterRestored);
