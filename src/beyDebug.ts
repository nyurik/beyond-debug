/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
	logger,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, DebugSession
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename, join } from 'path';
import { Subject } from 'await-notify';
import *  as dbg from './dbgmits';

import * as vscode from 'vscode';
import { BeyDbgSession } from './beyDbgSession';
import { TerminalEscape, TE_Style } from './terminalEscape';
import { TargetStopReason, IStackFrameVariablesInfo, IVariableInfo, IStackFrameInfo, IWatchInfo, IThreadInfo } from './dbgmits';
import { watch } from 'fs';
import { threadId } from 'worker_threads';
import { exit } from 'process';

function timeout(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function isFrameSame(f1?: IStackFrameInfo, f2?: IStackFrameInfo) {
	return (f1?.level === f2?.level) && (f1?.fullname === f2?.fullname) && (f1?.func === f2?.func);
}
/**
 * This interface describes the hi-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the hi-debug extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	debuggerPath?: string;
	debuggerArgs?: string[];
	program: string;
	cwd?: string;
	remote?: {
		enabled: boolean,
		address: string,
		mode: string,
		execfile: string,
		transfer: [{ from: string, to: string }]
	}
}
interface IAttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Traget process id to attach. */
	processId: number;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** run without debugging */
	noDebug?: boolean;
}
enum EMsgType {
	info,	//black
	error,
	alert,
	info2,
	info3,
}
export class BeyDebug extends DebugSession {

	private _variableHandles = new Handles<string>();

	private _configurationDone = new Subject();

	private _startDone = new Subject();

	private _cancelationTokens = new Map<number, boolean>();
	private _isRunning = false;


	private _progressId = 10000;
	private _cancelledProgressId: string | undefined = undefined;
	private _isProgressCancellable = true;

	private _breakPoints = new Map<string, DebugProtocol.Breakpoint[]>();

	private _locals: { frame?: IStackFrameInfo, vars: IVariableInfo[], watch: IWatchInfo[] } = { frame: null, vars: [], watch: [] };

	private _watchs: Map<string, IWatchInfo> = new Map();

	private _currentFrameLevel = 0;
	private _currentThreadId?: IThreadInfo;

	private dbgSession: BeyDbgSession;

	private sendMsgToDebugConsole(msg: string, itype: EMsgType = EMsgType.info) {
		let style = [TE_Style.Blue];
		// todo:vscode.window.activeColorTheme.kind is proposed-api in low version 
		// if (vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark) {

		// 	style = [TE_Style.BrightWhite];
		// 	switch (itype) {
		// 		case EMsgType.error:
		// 			style = [TE_Style.Red];
		// 			break;
		// 		case EMsgType.info2:
		// 			style = [TE_Style.Blue];
		// 		case EMsgType.alert:
		// 			style = [TE_Style.Yellow];
		// 		default:
		// 			break;
		// 	}
		// } else {
		//	style = [TE_Style.Black];

			switch (itype) {
				case EMsgType.error:
					style = [TE_Style.Red];
					break;
				case EMsgType.info2:
					style = [TE_Style.Blue];
				case EMsgType.alert:
					style = [TE_Style.Yellow];
				default:
					break;
			}
		//}

		this.sendEvent(new OutputEvent(TerminalEscape.apply({ msg: msg, style: style })));
		
	}
	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super(true);

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this.dbgSession = new BeyDbgSession('mi3');
		this.dbgSession.on(dbg.EVENT_SIGNAL_RECEIVED, (e: dbg.ISignalReceivedEvent) => {
			logger.log(e.reason.toString());
		});
		this.dbgSession.on(dbg.EVENT_DBG_CONSOLE_OUTPUT, (out: string) => {
			this.sendMsgToDebugConsole(out);
		});
		this.dbgSession.on(dbg.EVENT_TARGET_RUNNING, (out) => {
			this._isRunning = true;
			logger.log(out);
		});
		this.dbgSession.on(dbg.EVENT_TARGET_STOPPED, (e: dbg.ITargetStoppedEvent) => {
			logger.log("stoped:" + e.reason.toString());
			this._isRunning = false;
			this._variableHandles.reset();


			switch (e.reason) {

				case TargetStopReason.Exited:
				case TargetStopReason.ExitedNormally:
				case TargetStopReason.ExitedSignalled:
					this.sendEvent(new TerminatedEvent(false));
					break;
				default:
					this.sendEvent(new StoppedEvent('entry', e.threadId));
			}

		});

		this.dbgSession.on(dbg.EVENT_BREAKPOINT_HIT, (e: dbg.IBreakpointHitEvent) => {
			logger.log(e.reason.toString());
			this.sendEvent(new StoppedEvent('entry', e.threadId));
		});
		this.dbgSession.on(dbg.EVENT_TARGET_RUNNING, () => {

		});
		this.dbgSession.once(dbg.EVENT_SESSION_STARTED, () => {
			this._startDone.notify();
		});

	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {



		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = false;

		// make VS Code to support data breakpoints
		response.body.supportsDataBreakpoints = true;

		// make VS Code to support completion in REPL
		//todo 
		response.body.supportsCompletionsRequest = false;
		response.body.completionTriggerCharacters = [".", "["];

		// make VS Code to send cancelRequests
		response.body.supportsCancelRequest = false;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = false;

		// make VS Code provide "Step in Target" functionality
		response.body.supportsStepInTargetsRequest = false;

		response.body.supportsTerminateThreadsRequest = true;


		response.body.supportsReadMemoryRequest = false;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);


		this._configurationDone.notify();

		//notify the launchRequest that configuration has finished

	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {

		vscode.commands.executeCommand('workbench.panel.repl.view.focus');
		// make sure to 'Stop' the buffered logging if 'trace' is not set

		// wait until configuration has finished (and configurationDoneRequest has been called)
		this.dbgSession.startIt(args.debuggerPath, args.debuggerArgs);
		await this._configurationDone.wait(1001);
		//must wait for configure done. It will get error args without this.
		await this._startDone.wait(1002);
		//await this.dbgSession.execNativeCommand('-gdb-set mi-async on');
		if (args.cwd) {
			await this.dbgSession.environmentCd(args.cwd);
		}

		// start the program 
		let ret = await this.dbgSession.setExecutableFile(args.program).catch((e) => {

			vscode.window.showErrorMessage("Failed to start the debugger." + e.message);
			this.sendEvent(new TerminatedEvent(false));

			this.sendMsgToDebugConsole(e.message, EMsgType.error);

			return 1;
		});
		if (ret > 0) {
			return;
		}


		if (args.remote?.enabled) {
			if (!args.remote.address) {
				vscode.window.showErrorMessage("Invalid remote addr.");
			}
			let mode: string = args.remote.mode === undefined ? 'remote' : args.remote.mode;
			if (mode === 'remote') {
				let result = await this.dbgSession.connectToRemoteTargetEx(args.remote.address).catch((e) => {
					this.sendMsgToDebugConsole(e.message, EMsgType.error);
					vscode.window.showErrorMessage(e.message);
					return 1;
				});
				if (result > 0) {
					this.sendEvent(new TerminatedEvent(false));
					return;
				}
				this.dbgSession.resumeInferior();
				this.sendResponse(response);
				return;

			} else if (mode === 'extended-remote') {
				let result = await this.dbgSession.connectToRemoteTargetEx(args.remote.address, mode).catch((e) => {
					this.sendMsgToDebugConsole(e.message, EMsgType.error);
					vscode.window.showErrorMessage(e.message);
					return 1;
				});
				if (result > 0) {
					this.sendEvent(new TerminatedEvent(false));
					return;
				}
				if (args.remote.transfer) {
					this.sendMsgToDebugConsole("\n");
					for await (const trans of args.remote.transfer) {

						let id = "put" + trans.from;
						const startEvent: DebugProtocol.ProgressStartEvent = new ProgressStartEvent(id, `upload ${trans.from}`);
						startEvent.body.cancellable = false;
						this.sendEvent(startEvent);
						this.sendMsgToDebugConsole(`uploading : ${trans.from}\n`, EMsgType.info2);

						let endMessage = '`file uploaded : ${trans.from}';



						this.dbgSession.targetFilePut(trans.from, trans.to).catch((e) => {
							vscode.window.showErrorMessage(e.message);
							this.sendEvent(new ProgressEndEvent(id, e.message));
						}).then(() => {
							this.sendMsgToDebugConsole(`file uploaded : ${trans.from}\n`, EMsgType.info2);
							this.sendEvent(new ProgressEndEvent(id, endMessage));
						}
						);
					}
				}


				let execfile = args.remote.execfile ? args.remote.execfile : args.program;
				await this.dbgSession.execNativeCommand(`set remote exec-file ${execfile}`).catch((e) => {
					vscode.window.showErrorMessage("Failed to start the debugger." + e.message);
					this.sendEvent(new TerminatedEvent(false));
					return 1;
				});;

			} else {
				vscode.window.showErrorMessage('Invalid remote mode.');
				this.sendEvent(new TerminatedEvent(false));
				return;

			}


		}

		await this.dbgSession.startInferior().catch((e) => {
			this.sendMsgToDebugConsole(e.message, EMsgType.error);
			vscode.window.showErrorMessage("Failed to start the debugger." + e.message);
			this.sendEvent(new TerminatedEvent(false));
		});

		this.sendResponse(response);
	}

	protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments) {


		// make sure to 'Stop' the buffered logging if 'trace' is not set

		// wait until configuration has finished (and configurationDoneRequest has been called)
		this.dbgSession.startIt();
		await this._configurationDone.wait(1001);
		//must wait for configure done. It will get error args without this.
		await this._startDone.wait(1002);
		// start the program 

		this.dbgSession.setExecutableFile(args.program).catch((e) => {
			this.sendMsgToDebugConsole(e.message, EMsgType.error);
			vscode.window.showErrorMessage(e.message);
			this.sendEvent(new TerminatedEvent(false));
		});


		this.dbgSession.targetAttach(args.processId);

		this.sendResponse(response);
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): void {

		logger.log('pause');

	}


	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {

		let isPause = false;
		if (this._isRunning) {
			await this.dbgSession.pause();
			isPause = true;
		}
		const path = args.source.path as string;

		if (this._breakPoints.has(path)) {
			let bps: number[] = [];

			this._breakPoints.get(path).forEach((e) => {
				bps.push(e.id);
			});
			this._breakPoints.set(path, []);
			this.dbgSession.removeBreakpoints(bps);

		}

		const clientLines = args.breakpoints || [];
		const actualBreakpoints = await Promise.all(clientLines.map(async l => {
			let bk = await this.dbgSession.addBreakpoint(path + ":" + this.convertClientLineToDebugger(l.line), {
				isPending: true,
				condition: l.condition
			});
			//console.log(bk);
			const bp = new Breakpoint(false, this.convertDebuggerLineToClient(l.line)) as DebugProtocol.Breakpoint;
			bp.source = args.source;
			bp.verified = true;
			bp.id = bk.id;
			return bp;
		}));
		this._breakPoints.set(path, actualBreakpoints);
		if (isPause) {
			this.dbgSession.resumeAllInferiors(false);
		}
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);

	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {


		if (args.source.path) {
			response.body = {
				breakpoints: []
			};
		} else {
			response.body = {
				breakpoints: []
			};
		}
		this.sendResponse(response);
	}

	protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {

		let threads: Thread[] = [];
		let r = await this.dbgSession.getThreads();
		this._currentThreadId = r.current;
		r.all.forEach((th) => {
			threads.push(new Thread(th.id, th.name));
		});
		response.body = {
			threads: threads
		};
		this.sendResponse(response);

	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {

		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		const frames = await this.dbgSession.getStackFrames({ lowFrame: startFrame, highFrame: endFrame });

		//remove watchs 
		for await (const watch of this._watchs) {
			this.dbgSession.removeWatch(watch[1].id).catch(() => { });;
		}
		this._watchs.clear();

		response.body = {
			stackFrames: frames.map(f => {
				return new StackFrame(f.level, f.func, f.filename ? new Source(f.filename!, f.fullname) : null, this.convertDebuggerLineToClient(f.line!));
			}),
			totalFrames: frames.length
		};
		this.sendResponse(response);
	}

	protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {

		this._currentFrameLevel = args.frameId;



		response.body = {
			scopes: [
				{
					name: "Locals",
					variablesReference: this._variableHandles.create("locals::"),
					expensive: false
				},
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {

		const variables: DebugProtocol.Variable[] = [];

		const id = this._variableHandles.get(args.variablesReference);


		if (id === 'locals::') {
			for await (const w of this._locals.watch) {
				await this.dbgSession.removeWatch(w.id).catch(() => { });
			}
			let vals = await this.dbgSession.getStackFrameVariables(dbg.VariableDetailLevel.Simple, {
				frameLevel: this._currentFrameLevel,
				threadId: this._currentThreadId?.id
			});
			this._locals.vars = vals.args.concat(vals.locals);

			for await (const v of this._locals.vars) {

				let c = await this.dbgSession.addWatch(v.name, {
					frameLevel: this._currentFrameLevel,
					threadId: this._currentThreadId?.id
				}).catch(() => {

				});
				if (!c) {
					continue;
				}
				this._locals.watch.push(c);

				let vid = 0;
				if (c.childCount > 0) {
					vid = this._variableHandles.create(c.id);
				}

				variables.push({
					name: v.name,
					type: c.expressionType,
					value: c.value,
					variablesReference: vid,
					//memoryReference:c.expressionType.endsWith('*')?c.value:null
				});

			}

		} else {
			let childs = await this.dbgSession.getWatchChildren(id, { detail: dbg.VariableDetailLevel.All }).catch((e) => {
				return [];
			});

			for await (const c of childs) {
				let vid = 0;
				if (c.childCount > 0) {
					vid = this._variableHandles.create(c.id);
				}

				variables.push({
					name: c.expression,
					type: c.expressionType,
					value: c.value,
					variablesReference: vid
				});

			}


		}

		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.dbgSession.resumeAllInferiors(false);
		this.sendResponse(response);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
		this.dbgSession.resumeAllInferiors(true);
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.dbgSession.stepOverLine({ threadId: args.threadId });
		this.sendResponse(response);
	}


	protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {

		this.dbgSession.stepIntoLine({ threadId: args.threadId, });
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.dbgSession.stepOut({ threadId: args.threadId });
		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {

		if (args.context === 'repl') {
			let val = await this.dbgSession.execNativeCommand(args.expression);
		} else { //'watch hover'
			let key = this._currentThreadId?.id + "_" + this._currentFrameLevel + "_" + args.expression;
			let watch: void | IWatchInfo = this._watchs.get(key);

			if (!watch) {
				watch = await this.dbgSession.addWatch(args.expression, {
					frameLevel: this._currentFrameLevel,
					threadId: this._currentThreadId?.id
				}).catch((e) => {

				});;
				if (!watch) {
					response.body = {
						result: '<null>',
						type: undefined,
						variablesReference: 0
					};
					this.sendResponse(response);
					return;
				}

				this._watchs.set(key, watch);

			} else {
				let upd = await this.dbgSession.updateWatch(watch.id, dbg.VariableDetailLevel.Simple)
					.catch(() => { });
				if (upd) {
					if (upd.length > 0) {
						watch.value = upd[0].value;
						watch.expressionType = upd[0].expressionType;
						watch.childCount = upd[0].childCount;
					}
				}
			}

			let vid = 0;
			if (watch.childCount > 0) {
				vid = this._variableHandles.create(watch.id);
			}

			response.body = {
				result: watch.value,
				type: watch.expressionType,
				variablesReference: vid
			};
		}

		this.sendResponse(response);
	}

	private async progressSequence() {

		const ID = '' + this._progressId++;

		await timeout(100);

		const title = this._isProgressCancellable ? 'Cancellable operation' : 'Long running operation';
		const startEvent: DebugProtocol.ProgressStartEvent = new ProgressStartEvent(ID, title);
		startEvent.body.cancellable = this._isProgressCancellable;
		this._isProgressCancellable = !this._isProgressCancellable;
		this.sendEvent(startEvent);
		this.sendEvent(new OutputEvent(`start progress: ${ID}\n`));

		let endMessage = 'progress ended';

		for (let i = 0; i < 100; i++) {
			await timeout(500);
			this.sendEvent(new ProgressUpdateEvent(ID, `progress: ${i}`));
			if (this._cancelledProgressId === ID) {
				endMessage = 'progress cancelled';
				this._cancelledProgressId = undefined;
				this.sendEvent(new OutputEvent(`cancel progress: ${ID}\n`));
				break;
			}
		}
		this.sendEvent(new ProgressEndEvent(ID, endMessage));
		this.sendEvent(new OutputEvent(`end progress: ${ID}\n`));

		this._cancelledProgressId = undefined;
	}

	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {

		response.body = {
			dataId: null,
			description: "cannot break on data access",
			accessTypes: undefined,
			canPersist: false
		};

		if (args.variablesReference && args.name) {
			const id = this._variableHandles.get(args.variablesReference);
			if (id.startsWith("global_")) {
				response.body.dataId = args.name;
				response.body.description = args.name;
				response.body.accessTypes = ["read"];
				response.body.canPersist = true;
			}
		}

		this.sendResponse(response);
	}

	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {

		this.sendResponse(response);
	}

	protected async completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments) {

		//Not realized
		let aval = await this.dbgSession.interpreterExec(`complete ${args.text}`);
		response.body = {
			targets: [
				{
					label: "item 10",
					sortText: "10"
				},
				{
					label: "item 1",
					sortText: "01"
				},
				{
					label: "item 2",
					sortText: "02"
				},
				{
					label: "array[]",
					selectionStart: 6,
					sortText: "03"
				},
				{
					label: "func(arg)",
					selectionStart: 5,
					selectionLength: 3,
					sortText: "04"
				}
			]
		};
		this.sendResponse(response);
	}

	protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
		if (args.requestId) {
			this._cancelationTokens.set(args.requestId, true);
		}
		if (args.progressId) {
			this._cancelledProgressId = args.progressId;
		}
	}
	protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): void {
		logger.log(args.source!.path!);
	}


	protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request) {
		if (this._isRunning) {
			this.dbgSession.pause();
		}
		await this.dbgSession.end(true);
		this.sendResponse(response);
	}
}