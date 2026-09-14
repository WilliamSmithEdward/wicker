import type * as vscode from 'vscode';
import type { OffsetRange, SymfonyRoute } from '@wicker/core';

export type FrontendTarget = { projectPath: string; range: OffsetRange; label: string };
export type FrontendCandidate = FrontendTarget & { name: string; kind: vscode.CompletionItemKind; documentation?: string };
export type OutletConnection = { controller: string; outlet: string };
export type FrontendQuery = {
  range: OffsetRange;
  name: string;
  candidates: FrontendCandidate[];
  routes?: readonly SymfonyRoute[];
  targets?: FrontendTarget[];
  documentation?: string;
  outlet?: OutletConnection;
  declarations?: FrontendTarget[];
};
