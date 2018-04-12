// Copyright 2018 Valentin Ivanov (valen.ivanov@gmail.com)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BeamCache } from './beam/beamFileCache';

export default class BeamTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {

  private _didChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined> = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData?: vscode.Event<vscode.TreeItem | undefined> = this._didChangeTreeData.event;

  constructor(context: vscode.ExtensionContext, private workspaceRoot: string | undefined, private supportedSections: string[]) {

    let watcher = vscode.workspace.createFileSystemWatcher('**/*.{beam}');

    context.subscriptions.push(watcher);
    watcher.onDidChange(_ => triggerUpdateTree(), undefined, context.subscriptions);
    watcher.onDidCreate(_ => triggerUpdateTree(), undefined, context.subscriptions);
    watcher.onDidDelete(_ => triggerUpdateTree(), undefined, context.subscriptions);

    //For some reason onDidDelete is not firing when file is deleted outside of VS Code
    if (workspaceRoot && fs.existsSync(workspaceRoot)) {
      //Watcher is not 100% consistent on all platforms     
      let fsWatcher = fs.watch(workspaceRoot, { recursive: true }, (event: string, filename: string | Buffer) => {
        let file = (filename instanceof Buffer) ? filename.toString() : filename;

        if (path.extname(file) === ".beam") {
          if (event === 'rename') {
            triggerUpdateTree();
          }
        }
        return undefined;
      });

      if (fsWatcher) {
        context.subscriptions.push({ dispose(): any { fsWatcher.close(); } });
      }
    }

    var timeout: any = null;
    let provider = this;
    function triggerUpdateTree() {
      if (timeout) {
        clearTimeout(timeout);
      }

      timeout = setTimeout(() => {
        provider.refresh();
      }, 500);
    }
  }

  refresh(): void {
    this._didChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {

    if (!this.workspaceRoot) {
      vscode.window.showInformationMessage('No beam files in empty workspace');
      return Promise.resolve([]);
    }

    let root = this.workspaceRoot;

    return new Promise(resolve => {

      let toBeResolved: vscode.TreeItem[] = [];

      if (!element) {

        let dev: BeamVirtualFolder = new BeamVirtualFolder('dev');
        let prod: BeamVirtualFolder = new BeamVirtualFolder('prod');
        let deps: BeamVirtualFolder = new BeamVirtualFolder('deps');

        let otherBeamFiles: any[] = [];

        const isDirectory = (source: string) => fs.lstatSync(source).isDirectory();

        const getBeamFiles = (source: string) => {
          let items = fs.readdirSync(source);
          items.forEach((value: string) => {
            try {
              let fullPath = path.join(source, value);
              if (isDirectory(fullPath)) {
                getBeamFiles(fullPath);
              } else {
                if (path.extname(fullPath) === ".beam") {
                  if (fullPath.search('_build\\\\prod') !== -1) {
                    prod.items.push(new BeamFileItem(value, fullPath));
                  }
                  else if (fullPath.search('_build\\\\dev') !== -1) {
                    dev.items.push(new BeamFileItem(value, fullPath));
                  }
                  else if (fullPath.search('deps') !== -1) {
                    deps.items.push(new BeamFileItem(value, fullPath));
                  }
                  else {
                    otherBeamFiles.push({ name: value, location: fullPath });
                  }
                }
              }
            } catch (ex) {
            }
            finally {
            }
          });
        };

        getBeamFiles(root);

        let top: vscode.TreeItem[] = [dev, prod, deps];
        toBeResolved = top.concat(
          otherBeamFiles.map<vscode.TreeItem>(
            (item: any, index: number, array: any[]) => {
              return new BeamFileItem(item.name,
                item.location
              );
            }
          ));
      } else if (element instanceof BeamFileItem) {

        if (fs.existsSync(element.filePath)) {
          let beamFile = BeamCache.getBeamFile(element.filePath);

          for (const key in beamFile.sections) {
            if (beamFile.sections.hasOwnProperty(key)) {
              if (this.supportedSections.indexOf(key) !== -1 && !beamFile.sections[key].empty) {
                toBeResolved.push(new BeamChunkItem(beamFile.sections[key].name, key, element.filePath, `${key}.svg`));
              }
            }
          }
        }

      } else if (element instanceof BeamVirtualFolder) {
        toBeResolved = element.items;
      }

      return resolve(toBeResolved);
    });
  }
}

class BeamVirtualFolder extends vscode.TreeItem {
  constructor(public readonly label: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
  }

  items: vscode.TreeItem[] = [];
}

class BeamFileItem extends vscode.TreeItem {

  constructor(public readonly label: string,
    public readonly filePath: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);

    let elixirFile = false;

    if (label.startsWith('Elixir.')) {
      elixirFile = true;
    }

    this.iconPath = {
      light: path.join(__filename, '..', '..', 'resources', elixirFile ? 'elixir.svg' : 'erlang.svg'),
      dark: path.join(__filename, '..', '..', 'resources', elixirFile ? 'elixir.svg' : 'erlang.svg')
    };
  }

  get tooltip(): string {
    return this.filePath;
  }

  contextValue = 'beam';

  command = {
    command: "beamdasm.disassemble",
    arguments: [vscode.Uri.file(this.filePath), this],
    title: 'Open BEAM'
  };
}

class BeamChunkItem extends vscode.TreeItem {
  constructor(public readonly label: string, chunk: string, filePath: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);

    let sectionDocument = vscode.Uri.file(filePath.replace(".beam", `.beam_${chunk}`));
    this.command = {
      command: chunk === 'code' ? 'vscode.open' : 'vscode.previewHtml',
      arguments: [sectionDocument.with({ scheme: `beam${chunk.toLowerCase()}` })],
      title: `View ${chunk}`
    };
    this.iconPath = {
      light: path.join(__filename, '..', '..', 'resources', 'light', icon),
      dark: path.join(__filename, '..', '..', 'resources', 'dark', icon)
    };
  }

}