/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the worktree switcher. See ../common/worktrees.ts for what it does.

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { VIEW_ID as EXPLORER_VIEW_ID } from '../../files/common/files.js';
import { ctxWorktreesAvailable, IWorktreesService, WorktreesCommandId } from '../common/worktrees.js';
import { WorktreesService } from './worktreesService.js';

registerSingleton(IWorktreesService, WorktreesService, InstantiationType.Delayed);

registerAction2(class SwitchWorktreeAction extends Action2 {
	constructor() {
		super({
			id: WorktreesCommandId.Switch,
			title: localize2('switchWorktree', "Switch Worktree..."),
			icon: Codicon.worktree,
			f1: true,
			precondition: ctxWorktreesAvailable,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('view', EXPLORER_VIEW_ID), ctxWorktreesAvailable),
				group: 'navigation',
				order: 50,
			},
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IWorktreesService).pick();
	}
});

registerAction2(class CreateWorktreeAction extends Action2 {
	constructor() {
		super({
			id: WorktreesCommandId.Create,
			title: localize2('createWorktree', "Create Worktree..."),
			f1: true,
			precondition: ctxWorktreesAvailable,
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IWorktreesService).create();
	}
});

/**
 * The status bar names the worktree that the window shows, next to the branch. In the main checkout it shows how
 * many worktrees there are, and nothing when there are none.
 */
class WorktreesStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vsKotWorktreesStatus';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IWorktreesService private readonly _service: IWorktreesService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
	) {
		super();

		this._register(this._service.onDidChange(() => this._update()));
		this._update();
	}

	private _update(): void {
		const entry = this._getEntry();
		if (!entry) {
			this._entry.clear();
		} else if (this._entry.value) {
			this._entry.value.update(entry);
		} else {
			// Left of the branch, which git shows at 10000
			this._entry.value = this._statusbarService.addEntry(entry, 'status.vsKotWorktrees', StatusbarAlignment.LEFT, 10001);
		}
	}

	private _getEntry(): IStatusbarEntry | undefined {
		const state = this._service.state;
		const current = state?.current;
		if (!state || !current || (current.isMain && state.others.length === 0)) {
			return undefined;
		}

		const text = current.isMain ? `$(${Codicon.worktree.id}) ${state.others.length}` : `$(${Codicon.worktree.id}) ${current.name}`;
		let tooltip: string;
		if (current.isMain) {
			tooltip = state.others.length === 1
				? localize('statusMainOne', "This window shows the main checkout of {0}, which has 1 worktree. Select to switch to it.", current.name)
				: localize('statusMain', "This window shows the main checkout of {0}, which has {1} worktrees. Select to switch to one.", current.name, state.others.length);
		} else if (state.main) {
			tooltip = localize('statusWorktree', "This window shows the worktree {0} of {1}. Select to switch to another worktree or back to the main checkout.", current.name, state.main.name);
		} else {
			tooltip = localize('statusWorktreeNoMain', "This window shows the worktree {0}. Select to switch to another worktree.", current.name);
		}

		return {
			name: localize('statusName', "Worktree"),
			text,
			ariaLabel: tooltip,
			tooltip,
			command: WorktreesCommandId.Switch,
		};
	}
}

registerWorkbenchContribution2(WorktreesStatusContribution.ID, WorktreesStatusContribution, WorkbenchPhase.AfterRestored);
