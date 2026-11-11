// The page shortcuts reach the page bar through here: pageNav.js talks to the
// host, and shortcutCommands.js (loaded by the context, also in the tests)
// must not pull it in.
let turner = null;

export const setPageTurner = (turn) => {
  turner = turn;
};

export const turnPageCommand = (ctx, delta) => (turner ? turner(ctx, delta) : false);
