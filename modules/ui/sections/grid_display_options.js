import { select as d3_select } from 'd3-selection';

import { uiSection } from '../section';


export function uiSectionGridDisplayOptions(context) {
  const imagerySystem = context.systems.imagery;
  const rapid = context.systems.rapid;

  let section = uiSection(context, 'grid-display-options')
    .label(context.t('background.grid.grids'))
    .disclosureContent(gridDisplayOptions);

  const gridData = [
    { numSplit: 0, name: context.t('background.grid.no_grid')},
    { numSplit: 2, name: context.t('background.grid.n_by_n', { num: 2 }) },
    { numSplit: 3, name: context.t('background.grid.n_by_n', { num: 3 }) },
    { numSplit: 4, name: context.t('background.grid.n_by_n', { num: 4 }) },
    { numSplit: 5, name: context.t('background.grid.n_by_n', { num: 5 }) },
    { numSplit: 6, name: context.t('background.grid.n_by_n', { num: 6 }) }
  ];

  function chooseGrid(d3_event, d) {
    d3_event.preventDefault();
    imagerySystem.numGridSplits = d.numSplit;
  }


  function render(selection) {
    let container = selection.selectAll('.layer-grid-list')
      .data([0]);

    let gridList = container.enter()
      .append('ul')
      .attr('class', 'layer-list layer-grid-list')
      .attr('dir', 'auto')
      .merge(container);

    let gridItems = gridList.selectAll('li')
      .data(gridData, d => d.name);

    let enter = gridItems.enter()
      .insert('li', '.custom-gridsopt')
      .attr('class', 'gridsopt');

    let label = enter.append('label');

    label.append('input')
      .attr('type', 'radio')
      .attr('name', 'grids')
      .property('checked', d => d.numSplit === imagerySystem.numGridSplits)
      .on('change', chooseGrid);

    label.append('span')
      .text(d => d.name);

    gridItems.exit()
      .remove();
  }


  function gridDisplayOptions(selection) {
    let gridOptionsSection = d3_select('.section-grid-display-options');

    rapid.on('taskchanged', () => {
      if (rapid.isTaskRectangular()) {
        gridOptionsSection.classed('hide', false);
        selection.call(render);
      }
    });

    if (!rapid.isTaskRectangular()) {
      gridOptionsSection.classed('hide', true);
      return;
    }
  }


  return section;
}
