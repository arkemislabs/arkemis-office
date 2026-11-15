// The preset shape catalog: every preset deckcraft generates, in Shapes-gallery order, with its
// label, gallery category and default adjust values.
// Translated from deckcraft crates/geom/src/preset/catalog.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

export const CATEGORIES = Object.freeze(['lines', 'rectangles', 'basicShapes', 'blockArrows', 'equationShapes', 'flowchart', 'starsAndBanners', 'callouts', 'actionButtons']);
const LABELS = {lines: 'Lines', rectangles: 'Rectangles', basicShapes: 'Basic Shapes', blockArrows: 'Block Arrows', equationShapes: 'Equation Shapes',
  flowchart: 'Flowchart', starsAndBanners: 'Stars and Banners', callouts: 'Callouts', actionButtons: 'Action Buttons'};
export const categoryLabel = c => LABELS[c] ?? '';

const p = (name, label, category, defaults = []) => Object.freeze({name, label, category, defaults: Object.freeze(defaults)});
const L = 'lines', R = 'rectangles', B = 'basicShapes', A = 'blockArrows', E = 'equationShapes', F = 'flowchart', S = 'starsAndBanners', C = 'callouts', X = 'actionButtons';
const CB3 = [18750, -8333, 18750, -16667, 100000, -16667, 112963, -8333];
const CB2 = [18750, -8333, 18750, -16667, 112500, -46667];
const CB1 = [18750, -8333, 112500, -38333];

/** Every preset we generate, in gallery order. */
export const CATALOG = Object.freeze([
  p('line', 'Line', L), p('straightConnector1', 'Arrow', L), p('bentConnector3', 'Connector: Elbow', L, [50000]),
  p('curvedConnector3', 'Connector: Curved', L, [50000]), p('bentConnector2', 'Connector: Elbow (one bend)', L), p('lineInv', 'Line: Rising', L),
  p('rect', 'Rectangle', R), p('roundRect', 'Rectangle: Rounded Corners', R, [16667]), p('snip1Rect', 'Rectangle: Single Corner Snipped', R, [16667]),
  p('snip2SameRect', 'Rectangle: Top Corners Snipped', R, [16667, 0]), p('snip2DiagRect', 'Rectangle: Diagonal Corners Snipped', R, [0, 16667]),
  p('snipRoundRect', 'Rectangle: Top Corners One Rounded and One Snipped', R, [16667, 16667]),
  p('round1Rect', 'Rectangle: Single Corner Rounded', R, [16667]), p('round2SameRect', 'Rectangle: Top Corners Rounded', R, [16667, 0]),
  p('round2DiagRect', 'Rectangle: Diagonal Corners Rounded', R, [16667, 0]),
  p('textBox', 'Text Box', B), p('ellipse', 'Oval', B), p('triangle', 'Isosceles Triangle', B, [50000]), p('rtTriangle', 'Right Triangle', B),
  p('parallelogram', 'Parallelogram', B, [25000]), p('trapezoid', 'Trapezoid', B, [25000]), p('nonIsoscelesTrapezoid', 'Trapezoid: Uneven Sides', B, [25000, 25000]),
  p('diamond', 'Diamond', B), p('pentagon', 'Regular Pentagon', B), p('hexagon', 'Hexagon', B, [25000]), p('heptagon', 'Heptagon', B),
  p('octagon', 'Octagon', B, [29289]), p('decagon', 'Decagon', B), p('dodecagon', 'Dodecagon', B), p('pie', 'Partial Circle', B, [0, 16200000]),
  p('pieWedge', 'Quarter Wedge', B), p('chord', 'Chord', B, [2700000, 16200000]), p('teardrop', 'Teardrop', B, [100000]), p('frame', 'Frame', B, [12500]),
  p('cornerTabs', 'Corner Tabs: Triangles', B), p('squareTabs', 'Corner Tabs: Squares', B), p('plaqueTabs', 'Corner Tabs: Quarter Circles', B),
  p('halfFrame', 'Half Frame', B, [33333, 33333]), p('corner', 'L-Shape', B, [50000, 50000]), p('diagStripe', 'Diagonal Stripe', B, [50000]),
  p('plus', 'Cross', B, [25000]), p('plaque', 'Plaque', B, [16667]), p('can', 'Cylinder', B, [25000]), p('cube', 'Cube', B, [25000]),
  p('bevel', 'Bevel', B, [12500]), p('donut', 'Donut', B, [25000]), p('noSmoking', '"Not Allowed" Symbol', B, [18750]),
  p('blockArc', 'Block Arc', B, [10800000, 0, 25000]), p('foldedCorner', 'Folded Corner', B, [16667]), p('smileyFace', 'Smiley Face', B, [4653]),
  p('heart', 'Heart', B), p('lightningBolt', 'Lightning Bolt', B), p('sun', 'Sun', B, [25000]), p('moon', 'Moon', B, [50000]), p('cloud', 'Cloud', B),
  p('gear6', 'Gear: 6 Teeth', B, [15000, 3526]), p('gear9', 'Gear: 9 Teeth', B, [10000, 1763]), p('funnel', 'Funnel', B), p('arc', 'Arc', B, [16200000, 0]),
  p('bracketPair', 'Double Bracket', B, [16667]), p('bracePair', 'Double Brace', B, [8333]), p('leftBracket', 'Left Bracket', B, [8333]),
  p('rightBracket', 'Right Bracket', B, [8333]), p('leftBrace', 'Left Brace', B, [8333, 50000]), p('rightBrace', 'Right Brace', B, [8333, 50000]),
  p('chartX', 'Chart Marker: Cross Lines', B), p('chartStar', 'Chart Marker: Star Lines', B), p('chartPlus', 'Chart Marker: Plus Lines', B),
  p('rightArrow', 'Arrow: Right', A, [50000, 50000]), p('leftArrow', 'Arrow: Left', A, [50000, 50000]), p('upArrow', 'Arrow: Up', A, [50000, 50000]),
  p('downArrow', 'Arrow: Down', A, [50000, 50000]), p('leftRightArrow', 'Arrow: Left-Right', A, [50000, 50000]), p('upDownArrow', 'Arrow: Up-Down', A, [50000, 50000]),
  p('quadArrow', 'Arrow: Quad', A, [22500, 22500, 22500]), p('leftRightUpArrow', 'Arrow: Left-Right-Up', A, [25000, 25000, 25000]),
  p('bentArrow', 'Arrow: Bent', A, [25000, 25000, 25000, 43750]), p('uturnArrow', 'Arrow: U-Turn', A, [25000, 25000, 25000, 43750, 75000]),
  p('curvedRightArrow', 'Arrow: Curved Right', A, [25000, 50000, 25000]), p('curvedLeftArrow', 'Arrow: Curved Left', A, [25000, 50000, 25000]),
  p('curvedUpArrow', 'Arrow: Curved Up', A, [25000, 50000, 25000]), p('curvedDownArrow', 'Arrow: Curved Down', A, [25000, 50000, 25000]),
  p('leftUpArrow', 'Arrow: Left-Up', A, [25000, 25000, 25000]), p('bentUpArrow', 'Arrow: Bent-Up', A, [25000, 25000, 25000]),
  p('stripedRightArrow', 'Arrow: Striped Right', A, [50000, 50000]), p('notchedRightArrow', 'Arrow: Notched Right', A, [50000, 50000]),
  p('homePlate', 'Arrow: Pentagon', A, [50000]), p('chevron', 'Arrow: Chevron', A, [50000]),
  p('circularArrow', 'Arrow: Circular', A, [12500, 1142319, 20457681, 10800000, 12500]),
  p('leftCircularArrow', 'Arrow: Circular Counter-clockwise', A, [12500, -1142319, 1142319, 10800000, 12500]),
  p('leftRightCircularArrow', 'Arrow: Circular Two-headed', A, [12500, 1142319, 20457681, 11942319, 12500]),
  p('swooshArrow', 'Arrow: Swoosh', A, [25000, 16667]),
  p('rightArrowCallout', 'Callout: Right Arrow', A, [25000, 25000, 25000, 64977]), p('downArrowCallout', 'Callout: Down Arrow', A, [25000, 25000, 25000, 64977]),
  p('leftArrowCallout', 'Callout: Left Arrow', A, [25000, 25000, 25000, 64977]), p('upArrowCallout', 'Callout: Up Arrow', A, [25000, 25000, 25000, 64977]),
  p('leftRightArrowCallout', 'Callout: Left-Right Arrow', A, [25000, 25000, 25000, 48123]),
  p('upDownArrowCallout', 'Callout: Up-Down Arrow', A, [25000, 25000, 25000, 48123]),
  p('quadArrowCallout', 'Callout: Quad Arrow', A, [18515, 18515, 18515, 48123]),
  p('mathPlus', 'Plus Sign', E, [23520]), p('mathMinus', 'Minus Sign', E, [23520]), p('mathMultiply', 'Multiplication Sign', E, [23520]),
  p('mathDivide', 'Division Sign', E, [23520, 5880, 11760]), p('mathEqual', 'Equals', E, [23520, 11760]), p('mathNotEqual', 'Not Equal', E, [23520, 6600000, 11760]),
  p('flowChartProcess', 'Flowchart: Process', F), p('flowChartAlternateProcess', 'Flowchart: Alternate Process', F), p('flowChartDecision', 'Flowchart: Decision', F),
  p('flowChartInputOutput', 'Flowchart: Data', F), p('flowChartPredefinedProcess', 'Flowchart: Predefined Process', F),
  p('flowChartInternalStorage', 'Flowchart: Internal Storage', F), p('flowChartDocument', 'Flowchart: Document', F),
  p('flowChartMultidocument', 'Flowchart: Multidocument', F), p('flowChartTerminator', 'Flowchart: Terminator', F),
  p('flowChartPreparation', 'Flowchart: Preparation', F), p('flowChartManualInput', 'Flowchart: Manual Input', F),
  p('flowChartManualOperation', 'Flowchart: Manual Operation', F), p('flowChartConnector', 'Flowchart: Connector', F),
  p('flowChartOffpageConnector', 'Flowchart: Off-page Connector', F), p('flowChartPunchedCard', 'Flowchart: Card', F),
  p('flowChartPunchedTape', 'Flowchart: Punched Tape', F), p('flowChartSummingJunction', 'Flowchart: Summing Junction', F), p('flowChartOr', 'Flowchart: Or', F),
  p('flowChartCollate', 'Flowchart: Collate', F), p('flowChartSort', 'Flowchart: Sort', F), p('flowChartExtract', 'Flowchart: Extract', F),
  p('flowChartMerge', 'Flowchart: Merge', F), p('flowChartOnlineStorage', 'Flowchart: Stored Data', F), p('flowChartDelay', 'Flowchart: Delay', F),
  p('flowChartMagneticTape', 'Flowchart: Sequential Access Storage', F), p('flowChartMagneticDisk', 'Flowchart: Magnetic Disk', F),
  p('flowChartMagneticDrum', 'Flowchart: Direct Access Storage', F), p('flowChartDisplay', 'Flowchart: Display', F),
  p('flowChartOfflineStorage', 'Flowchart: Offline Storage', F),
  p('irregularSeal1', 'Explosion: 8 Points', S), p('irregularSeal2', 'Explosion: 14 Points', S), p('star4', 'Star: 4 Points', S, [12500]),
  p('star5', 'Star: 5 Points', S, [19098]), p('star6', 'Star: 6 Points', S, [28868]), p('star7', 'Star: 7 Points', S, [34601]), p('star8', 'Star: 8 Points', S, [37500]),
  p('star10', 'Star: 10 Points', S, [42533]), p('star12', 'Star: 12 Points', S, [37500]), p('star16', 'Star: 16 Points', S, [37500]),
  p('star24', 'Star: 24 Points', S, [37500]), p('star32', 'Star: 32 Points', S, [37500]), p('ribbon2', 'Ribbon: Tilted Up', S, [16667, 50000]),
  p('ribbon', 'Ribbon: Tilted Down', S, [16667, 50000]), p('ellipseRibbon2', 'Ribbon: Curved and Tilted Up', S, [25000, 50000, 12500]),
  p('ellipseRibbon', 'Ribbon: Curved and Tilted Down', S, [25000, 50000, 12500]), p('leftRightRibbon', 'Ribbon: Left-Right Fold', S, [50000, 50000, 16667]),
  p('verticalScroll', 'Scroll: Vertical', S, [12500]), p('horizontalScroll', 'Scroll: Horizontal', S, [12500]), p('wave', 'Wave', S, [12500, 0]),
  p('doubleWave', 'Double Wave', S, [6250, 0]),
  p('wedgeRectCallout', 'Speech Bubble: Rectangle', C, [-20833, 62500]),
  p('wedgeRoundRectCallout', 'Speech Bubble: Rectangle with Corners Rounded', C, [-20833, 62500, 16667]),
  p('wedgeEllipseCallout', 'Speech Bubble: Oval', C, [-20833, 62500]), p('cloudCallout', 'Thought Bubble: Cloud', C, [-20833, 62500]),
  p('borderCallout1', 'Callout: Line', C, CB1), p('borderCallout2', 'Callout: Bent Line', C, CB2), p('borderCallout3', 'Callout: Double Bent Line', C, CB3),
  p('accentCallout1', 'Callout: Line with Accent Bar', C, CB1), p('accentCallout2', 'Callout: Bent Line with Accent Bar', C, CB2),
  p('accentCallout3', 'Callout: Double Bent Line with Accent Bar', C, CB3), p('callout1', 'Callout: Line with No Border', C, CB1),
  p('callout2', 'Callout: Bent Line with No Border', C, CB2), p('callout3', 'Callout: Double Bent Line with No Border', C, CB3),
  p('accentBorderCallout1', 'Callout: Line with Border and Accent Bar', C, CB1),
  p('accentBorderCallout2', 'Callout: Bent Line with Border and Accent Bar', C, CB2),
  p('accentBorderCallout3', 'Callout: Double Bent Line with Border and Accent Bar', C, CB3),
  p('actionButtonBackPrevious', 'Action Button: Go Back or Previous', X), p('actionButtonForwardNext', 'Action Button: Go Forward or Next', X),
  p('actionButtonBeginning', 'Action Button: Go to Beginning', X), p('actionButtonEnd', 'Action Button: Go to End', X), p('actionButtonHome', 'Action Button: Go Home', X),
  p('actionButtonInformation', 'Action Button: Get Information', X), p('actionButtonReturn', 'Action Button: Go Back', X), p('actionButtonMovie', 'Action Button: Video', X),
  p('actionButtonDocument', 'Action Button: Document', X), p('actionButtonSound', 'Action Button: Sound', X), p('actionButtonHelp', 'Action Button: Help', X),
  p('actionButtonBlank', 'Action Button: Custom', X),
]);

const BY_NAME = new Map(CATALOG.map(i => [i.name, i]));
export const info = name => BY_NAME.get(name) ?? null;

const MITRED = new Set(['plus', 'rightArrow', 'upArrow', 'downArrow', 'upDownArrow', 'leftUpArrow', 'bentUpArrow', 'stripedRightArrow', 'notchedRightArrow',
  'chevron', 'leftArrowCallout', 'leftRightArrowCallout', 'upDownArrowCallout', 'quadArrowCallout', 'mathPlus', 'mathMinus', 'mathMultiply', 'mathEqual',
  'mathNotEqual', 'star5', 'star6', 'star8', 'star10', 'star12', 'star16', 'star24', 'star32', 'ellipseRibbon', 'ellipseRibbon2']);
/**
 * Whether PowerPoint joins this preset's outline with sharp (miter) corners when the line names
 * no join (it rounds them otherwise).
 */
export const mitredByDefault = name => MITRED.has(name) || String(name).startsWith('actionButton');

export const isLineLike = name => ['line', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'curvedConnector3', 'arc'].includes(name)
  || String(name).startsWith('bentConnector') || String(name).startsWith('curvedConnector');
