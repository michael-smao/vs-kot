/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, NotificationsFilter } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IPythonEnvironmentService } from '../common/pythonEnvironment.js';
import { PythonEnvironmentService, SELECT_PYTHON_ENVIRONMENT_COMMAND } from './pythonEnvironmentService.js';

registerSingleton(IPythonEnvironmentService, PythonEnvironmentService, InstantiationType.Delayed);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SELECT_PYTHON_ENVIRONMENT_COMMAND,
			title: localize2('selectPythonEnvironment', "Select Python Environment..."),
			f1: true
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IPythonEnvironmentService).selectEnvironment();
	}
});

/** Starts looking for the Python environment of the open folder once the window has settled. */
class PythonEnvironmentContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vsKotPythonEnvironment';

	constructor(@IPythonEnvironmentService _pythonEnvironmentService: IPythonEnvironmentService) { }
}

registerWorkbenchContribution2(PythonEnvironmentContribution.ID, PythonEnvironmentContribution, WorkbenchPhase.Eventually);

/** The built-in Ruff extension, as the source of its notifications. */
const RUFF_EXTENSION = 'charliermarsh.ruff';

/** Set once Ruff's notifications were made quiet, so that a later choice in the Do Not Disturb menu stays. */
const RUFF_NOTIFICATIONS_QUIETED_KEY = 'vsKotPython.ruffNotificationsQuieted';

/**
 * Keeps Ruff's hints out of sight. Ruff ships without Microsoft's Python extensions, and on its first start it
 * suggests installing them. VS Kot does not need them: it hands Ruff the environment itself, and either extension
 * would take the environment over from VS Kot. Ruff's information and warnings still reach the notification center,
 * and its errors still show. Runs before the extension host starts, so before Ruff can show anything.
 */
class RuffNotificationsContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vsKotRuffNotifications';

	constructor(
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
	) {
		if (storageService.getBoolean(RUFF_NOTIFICATIONS_QUIETED_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		storageService.store(RUFF_NOTIFICATIONS_QUIETED_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);

		if (!notificationService.getFilters().some(filter => filter.id === RUFF_EXTENSION)) {
			notificationService.setFilter({ id: RUFF_EXTENSION, label: 'Ruff', filter: NotificationsFilter.ERROR });
		}
	}
}

registerWorkbenchContribution2(RuffNotificationsContribution.ID, RuffNotificationsContribution, WorkbenchPhase.BlockStartup);
