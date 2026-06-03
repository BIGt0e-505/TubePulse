import React, { useState } from 'react';
import ConfirmDialog from './ConfirmDialog';

/**
 * Promise-based confirm dialog. Returns true if user confirmed, false
 * otherwise. Drop-in replacement for the platform-native Alert.alert
 * pattern, but rendered as an in-app modal that matches the dark theme.
 *
 * Usage in a component:
 *   const ok = await confirm({
 *     title: 'Remove channel?',
 *     message: 'This will stop tracking @channel.',
 *     confirmText: 'Remove',
 *     destructive: true,
 *   });
 *   if (ok) { ... }
 *
 * Implementation note: the global state lives in a singleton
 * `_confirmController` ref. Calling confirm() while a dialog is already
 * open will queue the new prompt (replacing the current one). For
 * most apps this is fine — destructive actions are user-initiated and
 * sequential.
 */

let _confirmController = null;

function _setState(updater) {
  if (_confirmController) _confirmController(updater);
}

/**
 * Show a confirm dialog and resolve with the user's choice.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} [options.confirmText='OK']
 * @param {string} [options.cancelText='Cancel']
 * @param {boolean} [options.destructive=false] — when true, the confirm
 *   button uses COLORS.danger (red-ish) instead of COLORS.accent.
 * @returns {Promise<boolean>}
 */
export function confirm(options) {
  return new Promise((resolve) => {
    _setState((prev) => ({
      visible: true,
      options,
      resolver: resolve,
    }));
  });
}

/**
 * The host component that renders the dialog. Place this near the root
 * of your app (alongside the screen stack) so it can overlay anything.
 */
export function ConfirmHost() {
  const [state, setState] = useState({ visible: false, options: null, resolver: null });

  // Register our setter so the global confirm() can call us.
  _confirmController = setState;

  const handleConfirm = () => {
    if (state.resolver) state.resolver(true);
    setState({ visible: false, options: null, resolver: null });
  };

  const handleCancel = () => {
    if (state.resolver) state.resolver(false);
    setState({ visible: false, options: null, resolver: null });
  };

  return (
    <ConfirmDialog
      visible={state.visible}
      title={state.options?.title}
      message={state.options?.message}
      confirmText={state.options?.confirmText || 'OK'}
      cancelText={state.options?.cancelText || 'Cancel'}
      destructive={state.options?.destructive || false}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );
}
