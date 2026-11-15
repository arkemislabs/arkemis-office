// Ribbon state binding (docs/architecture.md section 8.2).
//
// `useCommandState(command, args)` subscribes to the session's tick (one per commit or selection
// change) and reads the command's state(); the kernel memoizes state() per tick, so a ribbon with
// 150 visible controls costs at most 150 state() calls per selection change. Only mounted controls
// (the visible tab, the QAT and open menus) call it.

import {useCallback, useSyncExternalStore} from 'react';
import type {ControlState} from '../../../core/kernel/command.mjs';
import type {ExecResult} from '../../../core/kernel/session.mjs';
import type {Args, SpecControl} from '../../generated/spec-types';
import {concreteArgs} from '../model';
import {useEngine} from './EngineProvider';
import type {ShellState} from './ShellController';

/** The session tick: re-renders on every commit, selection change, view or prefs change. */
export function useSessionTick(): number {
  const {session} = useEngine();
  return useSyncExternalStore(session.subscribe, () => session.tick);
}

/** The shell's UI state (active tab, dialogs, panes, keytips...). */
export function useShellState(): ShellState {
  const {controller} = useEngine();
  return useSyncExternalStore(controller.subscribe, controller.getState);
}

/** A command's control state for its args; disabled with the reason when it is not registered. */
export function useCommandState(command: string | null | undefined, args?: Args | null): ControlState {
  const {session, docId} = useEngine();
  useSessionTick();
  if (!command) return {enabled: true};
  return session.state(docId, command, concreteArgs(args));
}

/** A spec control's state, including whether it is pending (section 8.7). */
export function useControlState(c: SpecControl, measuring = false): ControlState & {pending: boolean} {
  const {controller} = useEngine();
  useSessionTick();
  if (measuring) return {enabled: true, pending: !controller.isImplemented(c)};
  return controller.controlState(c);
}

/** runCommand(id, args, origin): the same path the ribbon uses (dialogs for missing params, toasts on error). */
export function useRunCommand() {
  const {controller} = useEngine();
  return useCallback((command: string, args?: Args | null, origin: 'ui' | 'shortcut' | 'dialog' = 'ui'): Promise<ExecResult | null> =>
    controller.run(command, args ?? null, {origin}), [controller]);
}

/** Non-hook form for code that has the controller. */
export function runCommand(controller: {run: (c: string, a: Args | null, o: {origin: 'ui' | 'shortcut' | 'dialog'}) => Promise<ExecResult | null>},
  command: string, args: Args | null = null, origin: 'ui' | 'shortcut' | 'dialog' = 'ui') {
  return controller.run(command, args, {origin});
}
