/** Keep native modal focus restoration when React removes the dialog. */
export function showDialog(
  dialog: HTMLDialogElement | null,
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null,
) {
  dialog?.showModal();
  return () => {
    const shouldRestore =
      document.activeElement === document.body || !!dialog?.contains(document.activeElement);
    dialog?.close();
    if (shouldRestore && opener?.isConnected) opener.focus({ preventScroll: true });
  };
}
