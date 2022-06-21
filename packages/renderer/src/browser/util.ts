/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Protocol} from 'devtools-protocol';
import {assert} from './assert';
import {CDPSession} from './Connection';
import {debug} from './Debug';
import {TimeoutError} from './Errors';
import {CommonEventEmitter} from './EventEmitter';

export const debugError = debug('puppeteer:error');

export function getExceptionMessage(
	exceptionDetails: Protocol.Runtime.ExceptionDetails
): string {
	if (exceptionDetails.exception) {
		return (
			exceptionDetails.exception.description || exceptionDetails.exception.value
		);
	}

	let message = exceptionDetails.text;
	if (exceptionDetails.stackTrace) {
		for (const callframe of exceptionDetails.stackTrace.callFrames) {
			const location =
				callframe.url +
				':' +
				callframe.lineNumber +
				':' +
				callframe.columnNumber;
			const functionName = callframe.functionName || '<anonymous>';
			message += `\n    at ${functionName} (${location})`;
		}
	}

	return message;
}

export function valueFromRemoteObject(
	remoteObject: Protocol.Runtime.RemoteObject
): any {
	assert(!remoteObject.objectId, 'Cannot extract value when objectId is given');
	if (remoteObject.unserializableValue) {
		if (remoteObject.type === 'bigint' && typeof BigInt !== 'undefined') {
			return BigInt(remoteObject.unserializableValue.replace('n', ''));
		}

		switch (remoteObject.unserializableValue) {
			case '-0':
				return -0;
			case 'NaN':
				return NaN;
			case 'Infinity':
				return Infinity;
			case '-Infinity':
				return -Infinity;
			default:
				throw new Error(
					'Unsupported unserializable value: ' +
						remoteObject.unserializableValue
				);
		}
	}

	return remoteObject.value;
}

export async function releaseObject(
	client: CDPSession,
	remoteObject: Protocol.Runtime.RemoteObject
): Promise<void> {
	if (!remoteObject.objectId) {
		return;
	}

	await client
		.send('Runtime.releaseObject', {objectId: remoteObject.objectId})
		.catch((error) => {
			// Exceptions might happen in case of a page been navigated or closed.
			// Swallow these since they are harmless and we don't leak anything in this case.
			debugError(error);
		});
}

export interface PuppeteerEventListener {
	emitter: CommonEventEmitter;
	eventName: string | symbol;
	handler: (...args: any[]) => void;
}

export function addEventListener(
	emitter: CommonEventEmitter,
	eventName: string | symbol,
	handler: (...args: any[]) => void
): PuppeteerEventListener {
	emitter.on(eventName, handler);
	return {emitter, eventName, handler};
}

export function removeEventListeners(
	listeners: Array<{
		emitter: CommonEventEmitter;
		eventName: string | symbol;
		handler: (...args: any[]) => void;
	}>
): void {
	for (const listener of listeners) {
		listener.emitter.removeListener(listener.eventName, listener.handler);
	}

	listeners.length = 0;
}

export const isString = (obj: unknown): obj is string => {
	return typeof obj === 'string' || obj instanceof String;
};

export const isNumber = (obj: unknown): obj is number => {
	return typeof obj === 'number' || obj instanceof Number;
};

export function evaluationString(
	fun: Function | string,
	...args: unknown[]
): string {
	if (isString(fun)) {
		assert(args.length === 0, 'Cannot evaluate a string with arguments');
		return fun;
	}

	function serializeArgument(arg: unknown): string {
		if (Object.is(arg, undefined)) {
			return 'undefined';
		}

		return JSON.stringify(arg);
	}

	return `(${fun})(${args.map(serializeArgument).join(',')})`;
}

export function pageBindingInitString(type: string, name: string): string {
	function addPageBinding(_type: string, bindingName: string): void {
		/* Cast window to any here as we're about to add properties to it
		 * via win[bindingName] which TypeScript doesn't like.
		 */
		const win = window as any;
		const binding = win[bindingName];

		win[bindingName] = (...args: unknown[]): Promise<unknown> => {
			const me = (window as any)[bindingName];
			let {callbacks} = me;
			if (!callbacks) {
				callbacks = new Map();
				me.callbacks = callbacks;
			}

			const seq = (me.lastSeq || 0) + 1;
			me.lastSeq = seq;
			const promise = new Promise((resolve, reject) => {
				callbacks.set(seq, {resolve, reject});
			});
			binding(JSON.stringify({type: _type, name: bindingName, seq, args}));
			return promise;
		};
	}

	return evaluationString(addPageBinding, type, name);
}

export function pageBindingDeliverResultString(
	name: string,
	seq: number,
	result: unknown
): string {
	function deliverResult(_name: string, _seq: number, _result: unknown): void {
		(window as any)[_name].callbacks.get(_seq).resolve(_result);
		(window as any)[_name].callbacks.delete(_seq);
	}

	return evaluationString(deliverResult, name, seq, result);
}

export function pageBindingDeliverErrorString(
	name: string,
	seq: number,
	message: string,
	stack?: string
): string {
	function deliverError(
		_name: string,
		_seq: number,
		_message: string,
		_stack?: string
	): void {
		const error = new Error(_message);
		error.stack = _stack;
		(window as any)[_name].callbacks.get(_seq).reject(error);
		(window as any)[_name].callbacks.delete(_seq);
	}

	return evaluationString(deliverError, name, seq, message, stack);
}

export function pageBindingDeliverErrorValueString(
	name: string,
	seq: number,
	value: unknown
): string {
	function deliverErrorValue(
		_name: string,
		_seq: number,
		_value: unknown
	): void {
		(window as any)[_name].callbacks.get(_seq).reject(_value);
		(window as any)[_name].callbacks.delete(_seq);
	}

	return evaluationString(deliverErrorValue, name, seq, value);
}

export function makePredicateString(
	predicate: Function,
	predicateQueryHandler?: Function
): string {
	function checkWaitForOptions(
		node: Node | null,
		waitForVisible: boolean,
		waitForHidden: boolean
	): Node | null | boolean {
		if (!node) {
			return waitForHidden;
		}

		if (!waitForVisible && !waitForHidden) {
			return node;
		}

		const element =
			node.nodeType === Node.TEXT_NODE
				? (node.parentElement as Element)
				: (node as Element);

		const style = window.getComputedStyle(element);
		const isVisible =
			style && style.visibility !== 'hidden' && hasVisibleBoundingBox();
		const success =
			waitForVisible === isVisible || waitForHidden === !isVisible;
		return success ? node : null;

		function hasVisibleBoundingBox(): boolean {
			const rect = element.getBoundingClientRect();
			return Boolean(rect.top || rect.bottom || rect.width || rect.height);
		}
	}

	const predicateQueryHandlerDef = predicateQueryHandler
		? `const predicateQueryHandler = ${predicateQueryHandler};`
		: '';
	return `
     (() => {
       ${predicateQueryHandlerDef}
       const checkWaitForOptions = ${checkWaitForOptions};
       return (${predicate})(...args)
     })() `;
}

export async function waitWithTimeout<T>(
	promise: Promise<T>,
	taskName: string,
	timeout: number
): Promise<T> {
	let reject: (reason?: Error) => void;
	const timeoutError = new TimeoutError(
		`waiting for ${taskName} failed: timeout ${timeout}ms exceeded`
	);
	const timeoutPromise = new Promise<T>((_res, rej) => {
		reject = rej;
	});
	let timeoutTimer = null;
	if (timeout) {
		timeoutTimer = setTimeout(() => {
			return reject(timeoutError);
		}, timeout);
	}

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
	}
}

interface ErrorLike extends Error {
	name: string;
	message: string;
}

export function isErrorLike(obj: unknown): obj is ErrorLike {
	return (
		typeof obj === 'object' && obj !== null && 'name' in obj && 'message' in obj
	);
}

export function isErrnoException(obj: unknown): obj is NodeJS.ErrnoException {
	return (
		isErrorLike(obj) &&
		('errno' in obj || 'code' in obj || 'path' in obj || 'syscall' in obj)
	);
}