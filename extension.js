// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

/** @type {Record<string, string>} Maps ftl.config.json color keys to TextMate grammar scopes. Edit ftl.config.json to change colors — reload the window to apply. */
const SCOPE_MAP = {
    directive: 'entity.name.function.ftl',
    interpolation: 'variable.other.interpolation.ftl',
    xmlTag: 'invalid.illegal.unrecognized-tag.html',
    xmlAttribute: 'entity.other.attribute-name.ftl',
    xmlAttributeValue: 'string.quoted.double.ftl',
    comment: 'comment.block.ftl',
    number: 'constant.numeric.ftl',
    operator: 'keyword.operator.ftl',
};

/** @type {Record<string, string>} Default colors applied when no ftl.config.json is present. */
const DEFAULT_COLORS = {
    directive: '#C586C0',
    interpolation: '#4EC9B0',
    xmlTag: '#4FC1FF',
    xmlAttribute: '#9CDCFE',
    xmlAttributeValue: '#CE9178',
    comment: '#6A9955',
    number: '#B5CEA8',
    operator: '#FFFFFF',
};

/** @returns {{ formatter?: { indentWidth?: number }, colors?: Record<string, string> } | null} */
function loadConfig() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const configPath = path.join(folders[0].uri.fsPath, 'ftl.config.json');
    if (!fs.existsSync(configPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
        vscode.window.showWarningMessage('ftl.config.json is not valid JSON.');
        return null;
    }
}

/**
 * Reads colors from ftl.config.json (falling back to defaults) and writes them
 * into the workspace editor.tokenColorCustomizations setting.
 * @param {{ formatter?: { indentWidth?: number }, colors?: Record<string, string> } | null} config
 */
function applyColors(config) {
    const colors = config?.colors ?? DEFAULT_COLORS;

    const newRules = Object.entries(colors)
        .filter(([key]) => SCOPE_MAP[key])
        .map(([key, color]) => ({ scope: SCOPE_MAP[key], settings: { foreground: color } }));

    if (newRules.length === 0) return;

    const wsConfig = vscode.workspace.getConfiguration();
    /** @type {{ textMateRules?: { scope: string, settings: object }[] } & Record<string, unknown>} */
    const current = /** @type {any} */ (wsConfig.get('editor.tokenColorCustomizations')) ?? {};
    const preserved = (current.textMateRules ?? []).filter(
        (r) => !newRules.some((nr) => nr.scope === r.scope)
    );

    wsConfig.update(
        'editor.tokenColorCustomizations',
        { ...current, textMateRules: [...preserved, ...newRules] },
        vscode.ConfigurationTarget.Global
    );
}

// ─── Formatter ───────────────────────────────────────────────────────────────

const FTL_BLOCK_OPEN =
    /^<#(if|list|items|sep|macro|function|switch|compress|escape|noescape|attempt|recover|nested)\b/;
const FTL_BLOCK_CLOSE =
    /^<\/(#if|#list|#items|#sep|#macro|#function|#switch|#compress|#escape|#noescape|#attempt|#recover|#nested)>/;
const FTL_ELSE_LIKE = /^<#(else|elseif)\b/;
const RE_XML_CLOSE = /^<\/[a-zA-Z]/;
const RE_TAG_LINE = /^<[/#!?a-zA-Z]/;
const RE_XML_OPEN = /^<[a-zA-Z:]/;

/**
 * Returns true if a trimmed line is a tag-like line (XML/FTL tag, FTL directive, comment).
 * @param {string} line
 */
function isTagLine(line) {
    return RE_TAG_LINE.test(line);
}

/**
 * Returns the next non-empty line after index i.
 * @param {string[]} lines
 * @param {number} i
 */
function nextNonEmpty(lines, i) {
    for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]) return lines[j];
    }
    return null;
}

/**
 * Finds the closing '>' of a tag starting at `start` in `line`,
 * skipping '>' characters that appear inside string literals.
 * @param {string} line
 * @param {number} start - index of the opening '<'
 * @returns {number} index of the closing '>', or -1 if not found
 */
function findTagEnd(line, start) {
    let inString = false;
    let stringChar = '';
    for (let i = start + 1; i < line.length; i++) {
        const ch = line[i];
        if (inString) {
            if (ch === stringChar) inString = false;
        } else if (ch === '"' || ch === "'") {
            inString = true;
            stringChar = ch;
        } else if (ch === '>') {
            return i;
        }
    }
    return -1;
}

/**
 * Splits a trimmed line into multiple lines when tags/directives are concatenated inline.
 * Uses quote-aware tag-end detection so '>' inside string literals is never mistaken
 * for a tag boundary.
 *
 * Handles all combinations:
 *   "</#if><tag>"          → ["</#if>", "<tag>"]
 *   "</tag><#if ...>"      → ["</tag>", "<#if ...>"]
 *   "<#else>NA"            → ["<#else>", "NA"]
 *   "<tag>content</tag>"   → ["<tag>content</tag>"] (kept intact — splitting would add whitespace to XML values)
 *   "<tag>content"         → ["<tag>", "content"]
 *   "content</tag>"        → ["content", "</tag>"]
 *
 * Safe: never splits inside string literals (e.g. ?replace("<br />", "\n"))
 * or FTL comparison operators (e.g. < 0, > 0).
 *
 * @param {string} line - already trimmed
 * @returns {string[]}
 */
function splitInlineContent(line) {
    if (!line.includes('<')) return [line];

    // Don't split <tag>content</tag> — keeping inline preserves whitespace in XML values
    if (/^<([a-zA-Z][a-zA-Z0-9:.-]*)(?:\s[^>]*)?>[^<]*<\/\1\s*>$/.test(line)) return [line];

    const tokens = [];
    let i = 0;

    while (i < line.length) {
        if (line[i] === '<') {
            const end = findTagEnd(line, i);
            if (end === -1) {
                // Unclosed tag — treat the rest as one token
                tokens.push(line.slice(i).trim());
                break;
            }
            tokens.push(line.slice(i, end + 1).trim());
            i = end + 1;
        } else {
            // Text content — read until the next '<' that is NOT inside a string literal
            let j = i;
            let inStr = false;
            let strCh = '';
            while (j < line.length) {
                const ch = line[j];
                if (inStr) {
                    if (ch === strCh) inStr = false;
                } else if (ch === '"' || ch === "'") {
                    inStr = true;
                    strCh = ch;
                } else if (ch === '<') {
                    break;
                }
                j++;
            }
            const text = line.slice(i, j).trim();
            if (text) tokens.push(text);
            i = j;
        }
    }

    const result = tokens.filter(Boolean);
    return result.length > 1 ? result : [line];
}

/**
 * Formats a FreeMarker Template file.
 * Indentation width is read from ftl.config.json (formatter.indentWidth), default 4.
 * @param {string} text
 * @param {{ formatter?: { indentWidth?: number }, colors?: Record<string, string> } | null} config
 * @returns {string}
 */
function formatFtl(text, config) {
    const INDENT_SIZE = config?.formatter?.indentWidth ?? 4;

    // Pre-process: expand lines where content/closing tags are inline, drop empty lines
    const expanded = [];
    for (const raw of text.split('\n')) {
        const t = raw.trim();
        if (!t) continue;
        for (const part of splitInlineContent(t)) {
            expanded.push(part);
        }
    }

    const output = [];
    let indentLevel = 0;
    let inMultiLineTag = false;

    for (let i = 0; i < expanded.length; i++) {
        const line = expanded[i]; // already trimmed by pre-processing

        if (!line) {
            output.push('');
            continue;
        }

        if (inMultiLineTag) {
            output.push(' '.repeat((indentLevel + 1) * INDENT_SIZE) + line);
            if (line.includes('>')) {
                inMultiLineTag = false;
                const nextTag = nextNonEmpty(expanded, i);
                if (!line.endsWith('/>') && nextTag && isTagLine(nextTag)) {
                    indentLevel++;
                }
            }
            continue;
        }

        const isClosingXmlTag = RE_XML_CLOSE.test(line);
        const isClosingFtlDirective = FTL_BLOCK_CLOSE.test(line);
        const isElseLike = FTL_ELSE_LIKE.test(line);

        if (isClosingXmlTag || isClosingFtlDirective || isElseLike) {
            indentLevel = Math.max(0, indentLevel - 1);
        }

        output.push(' '.repeat(indentLevel * INDENT_SIZE) + line);

        if (isClosingXmlTag || isClosingFtlDirective) {
            // no change after closing tag
        } else if (isElseLike || FTL_BLOCK_OPEN.test(line)) {
            indentLevel++;
        } else if (RE_XML_OPEN.test(line) && !/^<\?/.test(line) && !/^<!--/.test(line)) {
            if (line.trimEnd().endsWith('/>')) {
                // self-closing — no change
            } else if (line.includes('>')) {
                const tagMatch = line.match(/^<([a-zA-Z][a-zA-Z0-9:.-]*)/);
                if (tagMatch) {
                    const escapedTag = tagMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    if (!new RegExp('</' + escapedTag + '\\s*>').test(line)) {
                        indentLevel++;
                    }
                }
            } else {
                inMultiLineTag = true;
            }
        }
    }

    return output.join('\n');
}

// ─── Extension lifecycle ──────────────────────────────────────────────────────

/** @param {vscode.ExtensionContext} context */
function activate(context) {
    const config = loadConfig();
    applyColors(config);

    const formatterProvider = vscode.languages.registerDocumentFormattingEditProvider('ftl', {
        provideDocumentFormattingEdits(document) {
            const cfg = loadConfig();
            const original = document.getText();
            const formatted = formatFtl(original, cfg);
            if (formatted === original) return [];
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(original.length)
            );
            return [vscode.TextEdit.replace(fullRange, formatted)];
        },
    });

    const watcher = vscode.workspace.createFileSystemWatcher('**/ftl.config.json');
    watcher.onDidChange(() => applyColors(loadConfig()));
    watcher.onDidCreate(() => applyColors(loadConfig()));

    context.subscriptions.push(formatterProvider, watcher);
}

function deactivate() {}

module.exports = { activate, deactivate };
