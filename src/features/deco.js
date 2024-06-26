'use strict';
/**
 * @author github.com/tintinweb
 * @license GPLv3
 *
 *
 * */

const vscode = require('vscode');
const path = require('path');
const mod_parser = require('solidity-workspace');
const { getAstValueForExpression } = require('./symbols');
const settings = require('../settings');

async function decorateSourceUnit(document, editor, sourceUnit) {
	const config = settings.extensionConfig();
	let decorations = [];
	console.log('+ (decorate) in sourceunit: ' + sourceUnit.filePath);

	// Decorate external calls
	if (config.deco.warn.externalCalls) {
		decorations.push(...sourceUnit.getExternalCalls().map((c) => CreateDecoStyle.extCall(c._node)));
	}

	// Decorate state variables

	if (config.deco.statevars) {
		for (let contract of Object.values(sourceUnit.contracts)) {
			for (let svar of Object.values(contract.stateVars)) {
				decorations.push(CreateDecoStyle.stateVarDecl(svar, document, contract));

				svar.extra.usedAt.forEach((ident) => {
					if (ident.extra.inFunction.declarations[ident.name]) {
						// Shadowed state variable
						console.log('SHADOWED STATEVAR --> ' + ident.name);
						decorations.push(CreateDecoStyle.shadowedStateVar(ident, document, contract, svar));
						let declaration = ident.extra.inFunction.declarations[ident.name];
						decorations.push(CreateDecoStyle.shadowedStateVar(declaration, document, contract, svar));
					} else {
						// Not shadowed, decorate normally
						decorations.push(CreateDecoStyle.stateVarIdent(ident, document, contract, svar));
					}
				});
			}

			//decorate functions

			for (let func of contract.functions) {
				handleIdentifiers(func.identifiers, document, contract, settings, decorations);
			}

			//decorate modifiers
			for (let functionName in contract.modifiers) {
				handleIdentifiers(contract.modifiers[functionName].identifiers, document, contract, settings, decorations);
			}

			//decorate events
			for (var eventDef of contract.events) {
				if (settings.extensionConfig().deco.warn.reserved) {
					checkReservedIdentifiers(eventDef.arguments, decorations);
				}
			}
			console.log('✓ decorate scope (new) - identifier ');
		}
	}
	setDecorations(editor, decorations);
	console.log('✓ decorate scope done ');
}

function handleIdentifiers(identifiers, document, contract, settings, decorations) {
	let highlightIdentifiers = [];

	identifiers.forEach((ident) => {
		if (ident.name === undefined) return;

		const is_declared_locally = !!ident.extra.inFunction.declarations[ident.name];

		const is_state_var = !!contract.stateVars[ident.name];

		const is_inherited = !!(contract.inherited_names[ident.name] && contract.inherited_names[ident.name] != contract);

		if (is_declared_locally && !is_inherited && !is_state_var) {
			if (ident.extra.scope === 'argument' || ident.extra.scope === 'super') {
				highlightIdentifiers.push(ident);
			} else if (ident.extra.scope === 'storageRef') {
				decorations.push(CreateDecoStyle.stateVarIdent(ident, document, contract, ident.extra.declaration));
			} else if (ident.extra.scope === 'inheritedName') {
				decorations.push(CreateDecoStyle.shadowedInheritedStateVar(ident, document, contract));
			}
		} else if ((is_declared_locally && is_inherited) || (is_state_var && is_inherited)) {
			decorations.push(CreateDecoStyle.shadowedInheritedStateVar(ident, document, contract));
		} else if (is_inherited) {
			decorations.push(CreateDecoStyle.inheritedStateVar(ident, document, contract));
		}
	});

	if (settings.extensionConfig().deco.arguments) {
		semanticHighlightFunctionParameters(highlightIdentifiers, decorations);
	}

	if (settings.extensionConfig().deco.warn.reserved) {
		['identifiers', 'arguments', 'returns'].forEach((type) => {
			checkReservedIdentifiers(identifiers[type], decorations);
		});
	}
}

/** func decs */

function checkReservedIdentifiers(identifiers, decorations) {
	if (!identifiers) {
		return;
	}

	if (typeof identifiers.forEach !== 'function') {
		identifiers = Object.values(identifiers);
	}
	identifiers.forEach(function (ident) {
		if (mod_parser.RESERVED_KEYWORDS.indexOf(ident.name) >= 0) {
			decorations.push(mod_decorator.CreateDecoStyle.reserved(ident));
		}
	});
}

async function setDecorations(editor, decorations) {
	if (!editor) return;

	const decoMap = {};

	for (const styleKey in styles) {
		decoMap[styleKey] = [];
	}

	for (const deco of decorations) {
		decoMap[deco.decoStyle].push(deco);
	}

	for (const styleKey in decoMap) {
		editor.setDecorations(styles[styleKey], decoMap[styleKey]);
	}
}

async function decorateWords(editor, words, decoStyle, commentMapper) {
	if (!editor) {
		return;
	}
	var smallNumbers = [];
	const text = editor.document.getText();

	words.forEach(function (word) {
		//var regEx = new RegExp("\\b" +word+"\\b" ,"g");
		var regEx = new RegExp(word, 'g');
		let match;
		while ((match = regEx.exec(text))) {
			if (commentMapper && commentMapper.indexIsInComment(match.index, match.index + match[0].trim().length)) {
				continue;
			}
			var startPos = editor.document.positionAt(match.index);
			var endPos = editor.document.positionAt(match.index + match[0].trim().length);
			//endPos.line = startPos.line; //hacky force
			var decoration = {
				range: new vscode.Range(startPos, endPos),
				//isWholeLine: true,

				//hoverMessage: 'StateVar **' + match[0] + '**'
			};
			smallNumbers.push(decoration);
		}
	});
	console.log('✓ decorateWords ' + words);
	editor.setDecorations(decoStyle, smallNumbers);
}

function varDecIsArray(node) {
	return node && node.typeName && node.typeName.type == 'ArrayTypeName';
}

function getVariableDeclarationType(node) {
	if (!node) {
		return null;
	}

	if (typeof node.typeName != 'undefined' && node.typeName != null) {
		node = varDecIsArray(node) ? node.typeName.baseTypeName : node.typeName;
	}

	switch (node.type) {
		case 'ElementaryTypeName':
			return node.name;
		case 'UserDefinedTypeName':
			return node.namePath;
		case 'Mapping':
			return `mapping( ${getVariableDeclarationType(node.keyType)} => ${getVariableDeclarationType(node.valueType)} )`;
		default:
			return null;
	}
}

function semanticHighlightFunctionParameters(arrIdents, decorations) {
	if (arrIdents.length <= 0) {
		return [];
	}

	let funcNode = arrIdents[0].extra.inFunction;
	let colorAssign = {};

	Object.values(funcNode.arguments).forEach((ident, index) => {
		if (ident.name === null) return; //skip unnamed arguments (solidity allows function a(bytes,bytes))
		colorAssign[ident.name] = 'styleArgument' + ((index + 1) % 15);
		let typeName = getVariableDeclarationType(ident) || '';

		decorations.push({
			range: new vscode.Range(
				new vscode.Position(ident.loc.end.line - 1, ident.loc.end.column),
				new vscode.Position(ident.loc.end.line - 1, ident.loc.end.column + ident.name.length)
			),
			hoverMessage: `(*${typeName}*) **Argument** *${funcNode._node.name}*.**${ident.name}**`,
			decoStyle: colorAssign[ident.name],
		});
	});

	arrIdents.forEach((ident) => {
		let typeName = getVariableDeclarationType(ident.extra.declaration) || '';

		decorations.push({
			range: new vscode.Range(
				new vscode.Position(ident.loc.start.line - 1, ident.loc.start.column),
				new vscode.Position(ident.loc.end.line - 1, ident.loc.end.column + ident.name.length)
			),
			hoverMessage: `(*${typeName}*) **Argument** *${funcNode._node.name}*.**${ident.name}**`,
			decoStyle: colorAssign[ident.name],
		});
	});
	console.log(`✓ semantic highlight - ${funcNode._node.name}`);
}

//Styles

class CreateDecoStyle {
	static reserved(node) {
		let prefix = '**BUILTIN-RESERVED**  ❗RESERVED KEYWORD❗';
		let decoStyle = 'decoStyleLightOrange';
		let decl_uri = '[more info..](https://solidity.readthedocs.io/en/latest/miscellaneous.html#reserved-keywords)';

		return {
			range: new vscode.Range(
				new vscode.Position(node.loc.start.line - 1, node.loc.start.column),
				new vscode.Position(node.loc.end.line - 1, node.loc.end.column + node.name.length)
			),
			hoverMessage: `${prefix}**${node.name}** (${decl_uri})`,
			decoStyle: decoStyle,
		};
	}
	static extCall(node) {
		return {
			range: new vscode.Range(
				new vscode.Position(node.loc.start.line - 1, node.loc.start.column),
				new vscode.Position(node.loc.start.line - 1, node.loc.start.column + mod_parser.parserHelpers.getAstNodeName(node.expression).length) //only highlight first if extcall spans multiple lines
			),
			hoverMessage: '❗**EXTCALL**❗',
			decoStyle: 'decoStyleExternalCall',
		};
	}
	static stateVarDecl(node, document, contract) {
		var prefix = '';
		let knownValue = '';
		var decoStyle = 'decoStyleStateVar';

		if (node.isDeclaredConst) {
			prefix = '**CONST**  ';
			decoStyle = 'decoStyleLightGreen';
			knownValue = getAstValueForExpression(node.expression);
			knownValue = knownValue ? ` = **${knownValue}** ` : '';
		}

		if (node.hasOwnProperty('isImmutable') && node.isImmutable) {
			prefix = '**IMMUTABLE**  ';
			decoStyle = 'decoStyleStateVarImmutable';
		}

		return {
			range: new vscode.Range(
				new vscode.Position(node.identifier.loc.start.line - 1, node.identifier.loc.start.column),
				new vscode.Position(node.identifier.loc.end.line - 1, node.identifier.loc.end.column + node.identifier.name.length)
			),
			hoverMessage: `${prefix}(*${node.typeName.type == 'ElementaryTypeName' ? node.typeName.name : node.typeName.namePath}*) StateVar *${
				contract.name
			}*.**${node.identifier.name}**`,
			decoStyle: decoStyle,
		};
	}
	static stateVarIdent(node, document, contract, svar) {
		var prefix = '';
		let knownValue = '';
		var decoStyle = 'decoStyleStateVar';

		let decl_uri = `([Declaration: #${svar.loc.start.line}](${document.uri}#${svar.loc.start.line}))`;

		if (svar.isDeclaredConst) {
			prefix = '**CONST**  ';
			decoStyle = 'decoStyleLightGreen';
			knownValue = getAstValueForExpression(svar.expression);
			knownValue = knownValue ? ` = **${knownValue}** ` : '';
		}

		if (svar.hasOwnProperty('isImmutable') && svar.isImmutable) {
			prefix = '**IMMUTABLE**  ';
			decoStyle = 'decoStyleStateVarImmutable';
		}

		return {
			range: new vscode.Range(
				new vscode.Position(node.loc.start.line - 1, node.loc.start.column),
				new vscode.Position(node.loc.end.line - 1, node.loc.end.column + node.name.length)
			),
			hoverMessage: `${prefix}(*${svar.typeName.type == 'ElementaryTypeName' ? svar.typeName.name : svar.typeName.namePath}*) **StateVar** *${
				contract.name
			}*.**${svar.name}**${knownValue} ${decl_uri}`,
			decoStyle: decoStyle,
		};
	}
	static shadowedStateVar(node, document, contract, declaration, prefix) {
		let decoStyle = 'decoStyleLightOrange';
		prefix = prefix || '❗SHADOWED❗';
		let decl_uri = '([Declaration: #' + declaration.loc.start.line + '](' + document.uri + '#' + declaration.loc.start.line + '))';

		return {
			range: new vscode.Range(
				new vscode.Position(node.loc.start.line - 1, node.loc.start.column),
				new vscode.Position(node.loc.end.line - 1, node.loc.end.column + node.name.length)
			),
			hoverMessage: `${prefix}(*${
				declaration.typeName.type == 'ElementaryTypeName' ? declaration.typeName.name : declaration.typeName.namePath
			}*) **StateVar** *${contract.name}*.**${declaration.name}** ${decl_uri}`,
			decoStyle: decoStyle,
		};
	}
	static shadowedInheritedStateVar(node, document, contract, declaration) {
		let decoStyle = 'decoStyleLightOrange';
		let prefix = '**INHERITED**  ❗SHADOWED❗';
		declaration = declaration || node;
		let decl_uri = `([Declaration: #${node.loc.start.line}](${document.uri}#${node.loc.start.line}))`;
		let knownType = 'undef';

		let subcontract = contract.inherited_names[node.name];
		if (subcontract) {
			let foreignSourceUnit = subcontract._parent;
			let uri = vscode.Uri.file(foreignSourceUnit.filePath);
			declaration = subcontract.names[node.name]._node || node;
			decl_uri = `([Declaration: ${subcontract.name}#${declaration.loc.start.line}](${uri}#${declaration.loc.start.line}))`;
			knownType = getVariableDeclarationType(declaration);
		}

		return {
			range: new vscode.Range(
				new vscode.Position(node.loc.start.line - 1, node.loc.start.column),
				new vscode.Position(node.loc.end.line - 1, node.loc.end.column + node.name.length)
			),
			hoverMessage: `${prefix}(*${knownType}*) **StateVar** *${subcontract.name}*.**${node.name}** ${decl_uri}`,
			decoStyle: decoStyle,
		};
	}
	static inheritedStateVar(node, document, contract, declaration) {
		let decoStyle = 'decoStyleLightBlue';
		let prefix = '**INHERITED**  ';
		declaration = declaration || node;
		let decl_uri = `([Declaration: #${declaration.loc.start.line}](${document.uri}#${declaration.loc.start.line}))`;
		let knownType = getVariableDeclarationType(declaration);

		let subcontract = contract.inherited_names[node.name];
		if (subcontract) {
			let foreignSourceUnit = subcontract._parent;
			let uri = vscode.Uri.file(foreignSourceUnit.filePath);
			declaration = subcontract.names[node.name] || node;
			declaration = declaration.hasOwnProperty('_node') ? declaration._node : declaration;
			decl_uri = `([Declaration: ${subcontract.name}#${declaration.loc.start.line}](${uri}#${declaration.loc.start.line}))`;
			knownType = getVariableDeclarationType(declaration);
		}

		return {
			range: new vscode.Range(
				new vscode.Position(node.loc.start.line - 1, node.loc.start.column),
				new vscode.Position(node.loc.end.line - 1, node.loc.end.column + node.name.length)
			),
			hoverMessage: `${prefix}(*${knownType || '?'}*) **StateVar** *${subcontract ? subcontract.name : 'Unknown'}*.**${node.name}** ${decl_uri}`,
			decoStyle: decoStyle,
		};
	}
}

var gutterIcons = {};
var styles = {};

function init(context) {
	styles.decoStyleExternalCall = vscode.window.createTextEditorDecorationType({
		gutterIconPath: context.asAbsolutePath(path.join('images', 'warning.svg')),
		gutterIconSize: '50%',
	});

	const decoSuffix = settings.extensionConfig().deco.argumentsMode != 'color only' ? settings.extensionConfig().deco.argumentsSuffix : undefined;
	const shouldHighlightArg = settings.extensionConfig().deco.argumentsMode != 'symbol only';

	for (let idx = 0; idx < 15; idx++) {
		const hue = (((5 + idx) * 19) % 255) / 255;

		const lightBackground = shouldHighlightArg ? RGBtoHex(...HSLtoRGB(hue, 0.85, 0.75)) + '50' : undefined;

		const darkBackground = shouldHighlightArg ? RGBtoHex(...HSLtoRGB((((8 + idx) * 19) % 255) / 255, 0.99, 0.55)) + '30' : undefined;

		const afterColor = RGBtoHex(...HSLtoRGB(hue, 0.85, 0.75)) + '95';

		styles[`styleArgument${idx}`] = vscode.window.createTextEditorDecorationType({
			wholeLine: false,

			after: {
				contentText: decoSuffix,
				fontStyle: 'normal',
				color: afterColor,
			},
		});
	}

	gutterIcons.red = context.asAbsolutePath('images/bookmark-red.svg');
	gutterIcons.green = context.asAbsolutePath('images/bookmark-green.svg');
	gutterIcons.blue = context.asAbsolutePath('images/bookmark-blue.svg');
	gutterIcons.issue = context.asAbsolutePath('images/bookmark-issue.svg');

	const createBookmarkDecorationType = (gutterIconPath) => {
		return vscode.window.createTextEditorDecorationType({
			gutterIconPath,
		});
	};

	styles.decoStyleBookmarkRed = createBookmarkDecorationType(gutterIcons.red);
	styles.decoStyleBookmarkGreen = createBookmarkDecorationType(gutterIcons.green);
	styles.decoStyleBookmarkBlue = createBookmarkDecorationType(gutterIcons.blue);
	styles.decoStyleBookmarkIssue = createBookmarkDecorationType(gutterIcons.issue);

	const createDecorationType = (options) => {
		const { isWholeLine, color, border, borderWidth, borderColor, borderStyle, borderRadius, backgroundColor, gutterIconPath } = options;

		return vscode.window.createTextEditorDecorationType({
			isWholeLine,

			overviewRulerColor: settings.extensionConfig().overviewruler.decorations.enable ? borderColor || 'blue' : '',
			overviewRulerLane: settings.extensionConfig().overviewruler.decorations.enable ? vscode.OverviewRulerLane.Right : '',

			// borderColor: borderColor || 'GoldenRod',
			backgroundColor,
			color: color || '',
			border: border || 'none',
			borderWidth: borderWidth || '0',
			borderRadius: borderRadius || '0',
			borderStyle: borderStyle || 'solid',
			borderColor: borderColor || undefined,
			gutterIconPath,
		});
	};

	styles.decoStyleRedLine = createDecorationType({
		isWholeLine: true,
	});
	styles.decoStyleStateVar = createDecorationType({
		color: '#eaa25e',
		// borderWidth: '1.5px',
		// borderColor: 'DarkGoldenRod',
	});
	styles.decoStyleStateVarImmutable = createDecorationType({
		borderColor: '#eaa25e',
		borderRadius: '10px',
		borderWidth: '1.5px',
		color: '#eaa25e',
	});
	styles.decoStyleLightGreen = createDecorationType({
		borderColor: 'darkgreen',
	});
	styles.decoStyleLightOrange = createDecorationType({
		borderColor: 'red',
	});
	styles.decoStyleLightBlue = createDecorationType({ borderColor: 'darkblue' });
}

//utils

function HSLtoRGB(h, s, l) {
	let r, g, b;

	const rd = (a) => {
		return Math.floor(Math.max(Math.min(a * 256, 255), 0));
	};

	const hueToRGB = (m, n, o) => {
		if (o < 0) {
			o += 1;
		}
		if (o > 1) {
			o -= 1;
		}
		if (o < 1 / 6) {
			return m + (n - m) * 6 * o;
		}
		if (o < 1 / 2) {
			return n;
		}
		if (o < 2 / 3) {
			return m + (n - m) * (2 / 3 - o) * 6;
		}
		return m;
	};

	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;

	r = hueToRGB(p, q, h + 1 / 3);
	g = hueToRGB(p, q, h);
	b = hueToRGB(p, q, h - 1 / 3);

	return [rd(r), rd(g), rd(b)];
}

function RGBtoHex(r, g, b) {
	return `#${r.toString(16)}${g.toString(16)}${b.toString(16)}`;
}

module.exports = {
	init: init,
	decorateSourceUnit: decorateSourceUnit,
};
