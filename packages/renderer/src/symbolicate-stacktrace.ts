import {Protocol} from 'puppeteer-core';
import {Internals} from 'remotion';
import {readFile} from './assets/read-file';
import {RawSourceMap, SourceMapConsumer} from 'source-map';

function extractSourceMapUrl(
	fileUri: string,
	fileContents: string
): Promise<string> {
	const regex = /\/\/[#@] ?sourceMappingURL=([^\s'"]+)\s*$/gm;
	let match = null;
	for (;;) {
		const next = regex.exec(fileContents);
		if (next == null) {
			break;
		}

		match = next;
	}

	if (!match?.[1]) {
		return Promise.reject(
			new Error(`Cannot find a source map directive for ${fileUri}.`)
		);
	}

	return Promise.resolve(match[1].toString());
}

export async function getSourceMap(
	fileUri: string,
	fileContents: string
): Promise<SourceMapConsumer> {
	const sm = await extractSourceMapUrl(fileUri, fileContents);
	if (sm.indexOf('data:') === 0) {
		const base64 = /^data:application\/json;([\w=:"-]+;)*base64,/;
		const match2 = sm.match(base64);
		if (!match2) {
			throw new Error(
				'Sorry, non-base64 inline source-map encoding is not supported.'
			);
		}

		const converted = window.atob(sm.substring(match2[0].length));
		return new SourceMapConsumer(JSON.parse(converted) as RawSourceMap);
	}

	const index = fileUri.lastIndexOf('/');
	const url = fileUri.substring(0, index + 1) + sm;
	const obj = await fetchUrl(url);
	return new SourceMapConsumer(obj);
}

const fetchUrl = async (url: string) => {
	const res = await readFile(url);

	return new Promise<string>((resolve, reject) => {
		let downloaded = '';
		res.on('data', (d) => {
			downloaded += d;
		});
		res.on('end', () => {
			resolve(downloaded);
		});
		res.on('error', (err) => reject(err));
	});
};

export type ScriptLine = {
	lineNumber: number;
	content: string;
	highlight: boolean;
};

export type SymbolicatedStackFrame = {
	originalFunctionName: string;
	originalFileName: string | null;
	originalLineNumber: number | null;
	originalColumnNumber: number | null;
	originalScriptCode: ScriptLine[] | null;
};

function getLinesAround(
	line: number,
	count: number,
	lines: string[]
): ScriptLine[] {
	const result: ScriptLine[] = [];
	for (
		let index = Math.max(0, line - 1 - count);
		index <= Math.min(lines.length - 1, line - 1 + count);
		++index
	) {
		result.push({
			lineNumber: index + 1,
			content: lines[index],
			highlight: index === line,
		});
	}

	return result;
}

const getOriginalPosition = (
	source_map: SourceMapConsumer,
	line: number,
	column: number
): {source: string | null; line: number | null; column: number | null} => {
	const result = source_map.originalPositionFor({
		line,
		column,
	});
	return {line: result.line, column: result.column, source: result.source};
};

export const symbolicateStackTrace = async (
	frames: Protocol.Runtime.CallFrame[]
): Promise<SymbolicatedStackFrame[]> => {
	const uniqueFileNames = [
		...new Set(frames.map((f) => f.url).filter(Internals.truthy)),
	];
	const maps = await Promise.all(
		uniqueFileNames.map(async (fileName) => {
			const fileContents = await fetchUrl(fileName);
			return getSourceMap(fileName as string, fileContents as string);
		})
	);
	const mapValues: Record<string, SourceMapConsumer> = {};
	for (let i = 0; i < uniqueFileNames.length; i++) {
		mapValues[uniqueFileNames[i]] = maps[i];
	}

	return frames.map((frame): SymbolicatedStackFrame => {
		const map = mapValues[frame.url];
		const pos = getOriginalPosition(map, frame.lineNumber, frame.columnNumber);

		const {functionName} = frame;
		let hasSource: string | null = null;
		hasSource = pos.source ? map.sourceContentFor(pos.source, false) : null;

		const scriptCode =
			hasSource && pos.line
				? getLinesAround(pos.line, 3, hasSource.split('\n'))
				: null;

		return {
			originalColumnNumber: pos.column,
			originalFileName: pos.source,
			originalFunctionName: functionName,
			originalLineNumber: pos.line,
			originalScriptCode: scriptCode,
		};
	});
};