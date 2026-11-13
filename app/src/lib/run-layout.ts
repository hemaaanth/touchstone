// Where the run panel's layer sits (run-chat.tsx). Desktop: inside the chat
// area, below the top bar (which keeps no room for it), 12 px from the chat's
// top and right edges. Phone: below the bar, across the width.
export function panelLayerClass(narrow: boolean): string {
  return narrow ? "top-[54px] right-3 left-3" : "top-3 right-3"
}
