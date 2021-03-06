import * as vscode from 'vscode';
import { createTask } from './fl-build-utility';
import { getSettings } from './settings';
import { existsAsync, execAsync } from './utility';

export class TargetsTaskProvider implements vscode.TaskProvider, vscode.Disposable {
	private targetsPromise: Thenable<vscode.Task[]> | undefined = undefined;
	private disposables: vscode.Disposable[] = [];

	constructor(workspaceFolders: readonly vscode.WorkspaceFolder[]) {
		this.disposables = workspaceFolders
			.map((x) => getSettings(x))
			.flatMap((x) => x.fingerPrintingFiles.allFiles)
			.reduce((acc, v) => {
				const watcher = vscode.workspace.createFileSystemWatcher(v);
				watcher.onDidChange(() => (this.targetsPromise = undefined));
				watcher.onDidCreate(() => (this.targetsPromise = undefined));
				watcher.onDidDelete(() => (this.targetsPromise = undefined));
				return [...acc, watcher];
			}, [] as vscode.Disposable[]);

		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				this.targetsPromise = undefined;
			})
		);
	}

	public dispose() {
		this.disposables.forEach((x) => x.dispose());
	}

	public provideTasks(): Thenable<vscode.Task[]> | undefined {
		if (!this.targetsPromise) {
			this.targetsPromise = getTargets();
		}
		return this.targetsPromise;
	}

	public resolveTask(_task: vscode.Task): vscode.Task | undefined {
		return undefined;
	}
}

let _channel: vscode.OutputChannel;
function getOutputChannel(): vscode.OutputChannel {
	if (!_channel) {
		_channel = vscode.window.createOutputChannel('Faithlife.Build Auto Detection');
	}
	return _channel;
}

async function getTargets(): Promise<vscode.Task[]> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	const result: vscode.Task[] = [];
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return result;
	}

	for (const workspaceFolder of workspaceFolders) {
		const folderString = workspaceFolder.uri.fsPath;
		if (!folderString) {
			continue;
		}

		const settings = getSettings(workspaceFolder);
		const allFilesExists = await Promise.all(
			settings.fingerPrintingFiles.allFiles.map(existsAsync)
		);
		if (!allFilesExists.every((x) => x)) {
			continue;
		}

		const { commandLine, workingDirectory } = settings;
		try {
			const { stdout, stderr } = await execAsync(commandLine, { cwd: workingDirectory });
			if (stderr && stderr.length > 0) {
				getOutputChannel().appendLine(stderr);
				getOutputChannel().show(true);
			}
			if (stdout) {
				const { targets } = stdout.split(/\r{0,1}\n/).reduce(
					(acc, v) => {
						const { targets, reachedTargets } = acc;
						if (reachedTargets) {
							const target = v
								.split(' ')
								.map((x) => x.trim())
								.filter((x) => x.length > 0)[0];
							if (!target) {
								return acc;
							}
							return {
								reachedTargets,
								targets: [...targets, target],
							};
						}
						if (v.includes('Targets:')) {
							return { ...acc, reachedTargets: true };
						}
						return acc;
					},
					{ targets: [] as string[], reachedTargets: false }
				);
				for (const target of targets) {
					const task = createTask(workspaceFolder, target, settings);
					result.push(task);
				}
			}
		} catch (err) {
			const channel = getOutputChannel();
			if (err.stderr) {
				channel.appendLine(err.stderr);
			}
			if (err.stdout) {
				channel.appendLine(err.stdout);
			}
			channel.appendLine('Auto detecting Faithlife.Build targets failed.');
			channel.show(true);
		}
	}
	return result;
}
