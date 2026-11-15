// The dialog model contract (docs/architecture.md section 9.1).
import type {Ctx} from './command.mjs';

export type Values = Record<string, unknown>;
export interface FieldProblem { field: string; message: string }
export type CommandCall = {command: string; params: object; /** An in-dialog button that also closes the dialog once its command ran (Envelopes › New Document). */ close?: boolean};

export interface DialogModel<V extends Values = Values> {
  id: string;                                   // 'dialog.font' (spec dialogs[].id)
  title?: string;
  /** The title when it depends on the values ("Modify Tag" or "New Tag", "Change initials"). */
  titleFor?(values: V): string;
  command?: string;                             // submit command id (defaults to the spec's)
  init(ctx: Ctx, args?: Record<string, unknown> | null): V;                            // initial values from the selection (mixed -> null)
  derive?(values: V, changed: string[]): Partial<V>;
  validate(values: V): FieldProblem[];
  preview?(ctx: Ctx, values: V): unknown;       // pure data the preview field draws
  buttons?: Record<string, (ctx: Ctx, values: V) => CommandCall | null>;
  toCommand(values: V): CommandCall | {batch: CommandCall[]};
}

export declare function defineDialog<V extends Values>(d: DialogModel<V>): DialogModel<V>;
export declare function validateDialog(d: unknown, opts?: {where?: string}): string[];
export declare function dialogStem(id: string): string;
export declare function openDialogModel(session: import('./session.mjs').Session, docId: string | null, dialog: DialogModel): Values;
export declare function changeDialogValues(dialog: DialogModel, values: Values, field: string, value: unknown): Values;
export declare function submitDialog(session: import('./session.mjs').Session, docId: string | null, dialog: DialogModel, values: Values,
  opts?: {origin?: string; label?: string; approval?: {nonce: string}}): Promise<import('./session.mjs').ExecResult>;
export declare function pressDialogButton(session: import('./session.mjs').Session, docId: string | null, dialog: DialogModel, button: string,
  values: Values, opts?: {origin?: string}): Promise<import('./session.mjs').ExecResult | null>;
