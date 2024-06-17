'use strict';

const vscode = require('vscode');
const { CancellationTokenSource } = require('vscode');

const mod_decorator = require('./features/deco');
const { SolidityDocumentSymbolProvider } = require('./features/symbols');
const mod_parser = require('solidity-workspace');
const settings = require('./settings');

/** globals - const */
const languageId = settings.languageId;
const docSelector = settings.docSelector;

const g_workspace = new mod_parser.Workspace(vscode.workspace.workspaceFolders.map((wf) => wf.uri.fsPath));
var activeEditor;
var g_diagnostics;
var g_debounce = {
	timerId: undefined,
	armed: false,
	wait: 500,
};

const currentCancellationTokens = {
	onDidChange: new CancellationTokenSource(),
	onDidSave: new CancellationTokenSource(),
};

/*** EVENTS *********************************************** */

function onInitModules(context, type) {
	mod_decorator.init(context);
}

function analyzeSourceUnit(cancellationToken, document, editor, initialLoad = false, onFinished = () => {}) {
	console.log('inspect ...');

	if (!document) {
		console.error('-BUG- cannot analyze empty document!');
		return;
	}

	g_workspace
		.add(document.fileName, { content: document.getText(), cancellationToken: cancellationToken.token })
		.then((sourceUnit) => {
			console.log(`✓ inspect ${sourceUnit.filePath} ${sourceUnit.hash}`);
		})
		.catch((e) => {
			console.warn(`Error adding file or one of its dependencies to workspace (parser error): ${document.fileName}`);
			if (settings.extensionConfig().debug.parser.showExceptions) {
				console.error(e);
			}
		});

	g_workspace.withParserReady(document.fileName, initialLoad).then((finished) => {
		console.log('✓ workspace ready (linearized, resolved deps, ..)');
		const wantHash = mod_parser.SourceUnit.getHash(document.getText());
		if (
			cancellationToken.isCancellationRequested ||
			!finished.some((fp) => fp.value && fp.value.filePath === document.fileName && fp.value.hash === wantHash)
		) {
			//abort - new analysis running already OR our finished task is not in the tasklist :/
			onFinished();
			return;
		}

		let currentConfig = settings.extensionConfig();
		let shouldDecorate = currentConfig.deco.statevars || currentConfig.deco.arguments || currentConfig.deco.warn.reserved;

		if (shouldDecorate && editor) {
			let this_sourceUnit = g_workspace.get(document.fileName);
			mod_decorator.decorateSourceUnit(document, editor, this_sourceUnit);
			//decorate
		}
		onFinished();
		console.log('✓ analyzeSourceUnit - done');
	});
}

/** events */

function onDidSave(document) {
	currentCancellationTokens.onDidSave.dispose();
	currentCancellationTokens.onDidSave = new CancellationTokenSource();
	// check if there are any
	if (settings.extensionConfig().diagnostics.cdili_json.import && g_diagnostics) {
		g_diagnostics.updateIssues(currentCancellationTokens.onDidSave.token);
	}
}

function debounce(target) {
	if (!g_debounce.armed) {
		// unarmed: first time use
		g_debounce.armed = true; // arm for next run to enable debounce
		setTimeout(() => {
			target();
		}, 0);
	} else {
		// armed: debounce next calls
		clearTimeout(g_debounce.timerId); // clear timer & schedule new
		g_debounce.timerId = setTimeout(() => {
			target();
		}, g_debounce.wait);
	}
}

function refresh(editor, initialLoad = false) {
	let document = editor && editor.document ? editor.document : vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document : undefined;
	if (!document) {
		console.warn('change event on non-document');
		return;
	}
	if (document.languageId != languageId) {
		console.log('ondidchange: wrong langid');
		return;
	}
	currentCancellationTokens.onDidChange.cancel();
	currentCancellationTokens.onDidChange = new CancellationTokenSource();

	debounce(() => {
		console.log('--- on-did-change');
		try {
			analyzeSourceUnit(
				currentCancellationTokens.onDidChange,
				document,
				editor,
				initialLoad,
				/* onFinished */ () => {
					// cleanup
					g_debounce.armed = false; // unarm debounce
					g_debounce.timerId = undefined;
				}
			);
		} catch (err) {
			if (typeof err !== 'object') {
				//CancellationToken
				throw err;
			}
		}
		console.log('✓✓✓ on-did-change - resolved');
	});
}

function onDidChange(editor) {
	refresh(editor);
}

function onActivate(context) {
	activeEditor = vscode.window.activeTextEditor;

	console.log('onActivate');

	registerDocType(languageId, docSelector);

	async function registerDocType(type, docSel) {
		context.subscriptions.push(vscode.languages.reg);

		if (!settings.extensionConfig().mode.active) {
			console.log('ⓘ activate extension: entering passive mode. not registering any active code augmentation support.');
			return;
		}
		/** module init */
		onInitModules(context, type);
		refresh(activeEditor, true);

		/** event setup */
		/***** DidChange */
		vscode.window.onDidChangeActiveTextEditor(
			(editor) => {
				activeEditor = editor;
				if (editor && editor.document && editor.document.languageId == type) {
					onDidChange(editor);
				}
			},
			null,
			context.subscriptions
		);
		vscode.workspace.onDidChangeTextDocument(
			(event) => {
				if (
					activeEditor &&
					event.contentChanges.length > 0 && // only redecorate when there are content changes
					event.document === activeEditor.document &&
					event.document.languageId == type
				) {
					onDidChange(activeEditor);
				}
			},
			null,
			context.subscriptions
		);

		/***** OnSave */
		vscode.workspace.onDidSaveTextDocument(
			(document) => {
				onDidSave(document);
			},
			null,
			context.subscriptions
		);

		/****** OnOpen */
		vscode.workspace.onDidOpenTextDocument(
			(document) => {
				onDidSave(document);
			},
			null,
			context.subscriptions
		);

		/****** onDidChangeTextEditorSelection */
		vscode.window.onDidChangeTextEditorSelection(
			(event) /* TextEditorVisibleRangesChangeEvent */ => {
				cockpit.onDidSelectionChange(event); // let cockpit handle the event
			},
			null,
			context.subscriptions
		);

		/** experimental */
		if (settings.extensionConfig().outline.enable) {
			context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(docSel, new SolidityDocumentSymbolProvider(g_workspace)));
		}

		/**
		 * trigger decorations for visible editors
		 */
		vscode.window.visibleTextEditors.map((editor) => {
			if (editor && editor.document && editor.document.languageId == type) {
				onDidChange(editor);
			}
		});
	}
}

/* exports */
exports.activate = onActivate;
