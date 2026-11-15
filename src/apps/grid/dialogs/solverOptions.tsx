// Solver Options as Excel draws it: the All Methods, GRG Nonlinear and Evolutionary pages. All Methods groups Integer Optimality under "Solving with Integer
// Constraints" and the evaluation limit under "Solving Limits"; GRG Nonlinear says which of Excel's settings the solver keeps at its defaults; Evolutionary has
// Convergence, Mutation Rate, Population Size, Random Seed, Generations without Improvement and Require Bounds. Settings with no engine behind them are not drawn,
// and the pages say so (not checked against upstream).

import {useEffect, useState} from 'react';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Fld, Tabs, type SetValue} from './dataKit';

const Group = ({title, children}: {title: string; children: React.ReactNode}) => <fieldset className="so-group" style={{border: '1px solid rgba(255,255,255,.12)', borderRadius: 8, padding: '6px 10px 10px', margin: 0, display: 'flex', flexDirection: 'column', gap: 8}}>
  <legend style={{fontSize: 11.5, padding: '0 6px', opacity: .8}}>{title}</legend>{children}</fieldset>;

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const [tab, setTab] = useState(0);
  // OK finds a problem in a value: the page that has it comes up.
  useEffect(() => {
    const f = d.errors[0]?.field;
    if (f) setTab(['integerOptimality', 'maxEvaluations'].includes(f) ? 0 : 2);
  }, [d.errors]);
  return <div className="gd-fields">
    <Tabs names={['All Methods', 'GRG Nonlinear', 'Evolutionary']} current={tab} onPick={setTab} label="Solver option pages"/>
    {tab === 0 ? <div className="gd-fields">
      <Group title="Solving with Integer Constraints">
        <Fld d={d} set={setValue} id="integerOptimality" kind="number" label="Integer Optimality (%):"/>
      </Group>
      <Group title="Solving Limits">
        <Fld d={d} set={setValue} id="maxEvaluations" kind="number" label="Iterations (most evaluations):"/>
      </Group>
      <p className="sf-note" style={{margin: 0}}>Constraint Precision, Use Automatic Scaling, Show Iteration Results, Ignore Integer Constraints and Max Time use the solver's defaults.</p>
    </div> : null}
    {tab === 1 ? <div className="gd-fields">
      <p className="sf-note" style={{margin: 0}}>The GRG Nonlinear method has no settings of its own here. Convergence, Derivatives (Forward or Central) and Multistart use the solver's defaults; the evaluation limit on the All Methods page applies to it.</p>
    </div> : null}
    {tab === 2 ? <div className="gd-fields">
      <div className="data-two">
        <Fld d={d} set={setValue} id="convergence" kind="number" label="Convergence:"/>
        <Fld d={d} set={setValue} id="mutationRate" kind="number" label="Mutation Rate:"/>
        <Fld d={d} set={setValue} id="populationSize" kind="number" label="Population Size:"/>
        <Fld d={d} set={setValue} id="randomSeed" kind="number" label="Random Seed:"/>
      </div>
      <Fld d={d} set={setValue} id="generationsWithoutImprovement" kind="number" label="Generations without Improvement:"/>
      <Fld d={d} set={setValue} id="requireBounds" kind="checkbox" label="Require Bounds on Variable Cells"/>
    </div> : null}
  </div>;
}

export default {Body};
