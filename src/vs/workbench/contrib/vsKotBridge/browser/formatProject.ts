/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: formats every file of the project with the team's formatter, for `format-project` of the bridge.
//
// Formatting changes files, and a changed file that is not staged counts as not reviewed. What the formatter
// changes needs no approval, so a file it changed is saved and staged at once. A file that is under review is left
// alone: it is formatted anyway when its changes are approved, and the formatter's changes would otherwise mix with
// the ones that still need a look. So is a file with unsaved changes, which are the reviewer's own work.

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isEqual, isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { formatDocumentWithSelectedProvider, FormattingMode } from '../../../../editor/contrib/format/browser/format.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Progress } from '../../../../platform/progress/common/progress.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { SaveReason } from '../../../common/editor.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IChangeReviewService } from '../../changeReview/common/changeReview.js';
import { ISCMService } from '../../scm/common/scm.js';
import { IVsKotBridgeFormatResult } from '../common/vsKotBridge.js';

/** The kinds of files Prettier formats. Others are not even opened. */
const FORMATTED_FILES = '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,json,jsonc,json5,css,scss,less,html,htm,vue,md,mdx,yaml,yml,graphql,gql,hbs,handlebars}';

/** The command of the git extension that the review stages a whole file with. */
const STAGE_FILE_COMMAND = 'git.stageFile';
/**
 * The git extension stages only what it lists as changed, and after a save it reads the status again only once the
 * window is in front. From a key of Anydeck it is often behind, so the status is read here before staging.
 */
const REFRESH_COMMAND = 'git.refresh';

/**
 * Formats the files of the open folders, as far as git does not ignore them.
 * @param onProgress told after each file
 */
export async function formatProject(accessor: ServicesAccessor, onProgress: (result: IVsKotBridgeFormatResult, total: number) => void, token: CancellationToken): Promise<IVsKotBridgeFormatResult> {
	// All services now: the accessor is gone after the first await
	const contextService = accessor.get(IWorkspaceContextService);
	const searchService = accessor.get(ISearchService);
	const instantiationService = accessor.get(IInstantiationService);
	const textModelService = accessor.get(ITextModelService);
	const textFileService = accessor.get(ITextFileService);
	const reviewService = accessor.get(IChangeReviewService);
	const commandService = accessor.get(ICommandService);
	const logService = accessor.get(ILogService);
	const scmService = accessor.get(ISCMService);

	const folders = contextService.getWorkspace().folders;
	if (folders.length === 0) {
		return { checked: 0, formatted: 0, skipped: 0 };
	}

	// The search follows .gitignore and the exclude settings, so node_modules and build output stay out
	const query = instantiationService.createInstance(QueryBuilder).file(folders, { includePattern: FORMATTED_FILES, _reason: 'vsKotFormatProject' });
	const found = await searchService.fileSearch(query, token);
	const files = found.results.map(result => result.resource);

	let checked = 0;
	let formatted = 0;
	let skipped = 0;
	const isUnderReview = (uri: URI) => reviewService.files.some(file => isEqual(file.uri, uri));
	// Asked before the git extension is: for a file outside its repositories, it would ask the user to pick one
	const isInGitRepository = (uri: URI) => [...scmService.repositories].some(repository => repository.provider.providerId === 'git' && !!repository.provider.rootUri && isEqualOrParent(uri, repository.provider.rootUri));

	for (const uri of files) {
		if (token.isCancellationRequested) {
			break;
		}
		checked++;

		// Looked at again for every file: the review may have changed while the files before were formatted
		if (isUnderReview(uri) || textFileService.isDirty(uri)) {
			skipped++;
			onProgress({ checked, formatted, skipped }, files.length);
			continue;
		}

		try {
			const reference = await textModelService.createModelReference(uri);
			try {
				const model = reference.object.textEditorModel;
				const before = model.getAlternativeVersionId();
				await instantiationService.invokeFunction(formatDocumentWithSelectedProvider, model, FormattingMode.Silent, Progress.None, token, false);
				if (model.getAlternativeVersionId() !== before) {
					// The formatter ran already, so the save does not run it again
					await textFileService.save(uri, { reason: SaveReason.EXPLICIT, skipSaveParticipants: true });
					if (isInGitRepository(uri)) {
						try {
							await commandService.executeCommand(REFRESH_COMMAND, uri);
							await commandService.executeCommand(STAGE_FILE_COMMAND, uri);
						} catch (error) {
							logService.warn(`[vs-kot bridge] could not stage ${uri.fsPath}`, error);
						}
					}
					formatted++;
				}
			} finally {
				reference.dispose();
			}
		} catch (error) {
			// A file that cannot be read or formatted, such as one with a syntax error, stays as it is
			logService.warn(`[vs-kot bridge] could not format ${uri.fsPath}`, error);
		}
		onProgress({ checked, formatted, skipped }, files.length);
	}

	return { checked, formatted, skipped };
}

