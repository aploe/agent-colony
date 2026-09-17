/* Die 2D-Fassade: reicht die heutigen Module unter den zwoelf Namen durch,
 * die auch r3d/index.mjs exportiert. Hier steht keine Logik — wer eine
 * sucht, findet sie ueber den Import. Der Ordner heisst r2d/, damit das
 * spaetere Herausziehen des gemeinsamen Kerns die 2D-Module hierher
 * verschieben kann, ohne die Fassade umzubenennen. */

import { chipAt } from '../collapse.mjs';
import { hideDayTip } from '../daytip.mjs';
import { animateView, cancelViewAnim, draw, fitView, resize, scheduleTick } from '../map.mjs';
import { dayAt } from '../skyline.mjs';
import { app } from '../store.mjs';
import { hexAt, hexCenter, hexTarget } from '../view.mjs';

const el = () => document.getElementById('colony');

function mount() {
  el().hidden = false;
}

function unmount() {
  cancelViewAnim();
  // Zeigerzustand ist geteilt (store.mjs): ohne das leckt ein Hover aus 2D
  // nach 3D, ohne dass sich die Maus bewegt (Review Task 6, R15).
  app.hover = null;
  app.chipHover = null;
  hideDayTip();
  el().style.cursor = '';
  el().hidden = true;
}

const focusHex = (h) => animateView(hexTarget(h));
const cancelAnim = cancelViewAnim;
const pickHex = hexAt;
const pickDay = dayAt;
const pickChip = chipAt;
const dayAnchor = (h, day) => ({ hex: h, day, c: hexCenter(h) });

export { cancelAnim, dayAnchor, draw, fitView, focusHex, mount, pickChip, pickDay, pickHex, resize, scheduleTick, unmount };
