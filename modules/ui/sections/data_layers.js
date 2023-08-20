import { select as d3_select } from 'd3-selection';

import { uiTooltip } from '../tooltip';
import { uiIcon } from '../icon';
import { uiCmd } from '../cmd';
import { uiSection } from '../section';
import { uiSettingsCustomData } from '../settings/custom_data';


export function uiSectionDataLayers(context) {
  const l10n = context.systems.l10n;
  const section = uiSection(context, 'data-layers')
    .label(l10n.tHtml('map_data.data_layers'))
    .disclosureContent(renderDisclosureContent);

  const settingsCustomData = uiSettingsCustomData(context)
    .on('change', customChanged);

  const scene = context.scene();


  function renderDisclosureContent(selection) {
    let container = selection.selectAll('.data-layer-container')
      .data([0]);

    container.enter()
      .append('div')
      .attr('class', 'data-layer-container')
      .merge(container)
      .call(drawOsmItems)
      .call(drawQAItems)
      .call(drawCustomDataItems)
      .call(drawPanelItems);
  }


  function showsLayer(layerID) {
    const layer = scene.layers.get(layerID);
    return layer && layer.enabled;
  }


  function setLayer(layerID, val) {
    // Don't allow layer changes while drawing - iD#6584
    const mode = context.mode;
    if (mode && /^draw/.test(mode.id)) return;

    if (val) {
      scene.enableLayers(layerID);
    } else {
      scene.disableLayers(layerID);
      if (layerID === 'osm' || layerID === 'notes') {
        context.enter('browse');
      }
    }
  }


  function toggleLayer(layerID) {
    setLayer(layerID, !showsLayer(layerID));
  }


  function drawOsmItems(selection) {
    const osmKeys = ['osm', 'notes'];
    const osmLayers = osmKeys.map(layerID => scene.layers.get(layerID)).filter(Boolean);

    let ul = selection
      .selectAll('.layer-list-osm')
      .data([0]);

    ul = ul.enter()
      .append('ul')
      .attr('class', 'layer-list layer-list-osm')
      .merge(ul);

    let li = ul.selectAll('.list-item')
      .data(osmLayers);

    li.exit()
      .remove();

    let liEnter = li.enter()
      .append('li')
      .attr('class', d => `list-item list-item-${d.id}`);

    let labelEnter = liEnter
      .append('label')
      .each((d, i, nodes) => {
        if (d.id === 'osm') {
          d3_select(nodes[i])
            .call(uiTooltip(context)
              .title(l10n.tHtml(`map_data.layers.${d.id}.tooltip`))
              .keys([uiCmd('⌥' + l10n.t('area_fill.wireframe.key'))])
              .placement('bottom')
            );
        } else {
          d3_select(nodes[i])
            .call(uiTooltip(context)
              .title(l10n.tHtml(`map_data.layers.${d.id}.tooltip`))
              .placement('bottom')
            );
        }
      });

    labelEnter
      .append('input')
      .attr('type', 'checkbox')
      .on('change', (d3_event, d) => toggleLayer(d.id));

    labelEnter
      .append('span')
      .html(d => l10n.tHtml(`map_data.layers.${d.id}.title`));

    // Update
    li
      .merge(liEnter)
      .classed('active', d => d.enabled)
      .selectAll('input')
      .property('checked', d => d.enabled);
  }


  function drawQAItems(selection) {
    const qaKeys = ['keepRight', 'improveOSM', 'osmose'];
    const qaLayers = qaKeys.map(layerID => scene.layers.get(layerID)).filter(Boolean);

    let ul = selection
      .selectAll('.layer-list-qa')
      .data([0]);

    ul = ul.enter()
      .append('ul')
      .attr('class', 'layer-list layer-list-qa')
      .merge(ul);

    let li = ul.selectAll('.list-item')
      .data(qaLayers);

    li.exit()
      .remove();

    let liEnter = li.enter()
      .append('li')
      .attr('class', d => `list-item list-item-${d.id}`);

    let labelEnter = liEnter
      .append('label')
      .each((d, i, nodes) => {
        d3_select(nodes[i])
          .call(uiTooltip(context)
            .title(l10n.tHtml(`map_data.layers.${d.id}.tooltip`))
            .placement('bottom')
          );
      });

    labelEnter
      .append('input')
      .attr('type', 'checkbox')
      .on('change', (d3_event, d) => toggleLayer(d.id));

    labelEnter
      .append('span')
      .html(d => l10n.tHtml(`map_data.layers.${d.id}.title`));

    // Update
    li
      .merge(liEnter)
      .classed('active', d => d.enabled)
      .selectAll('input')
      .property('checked', d => d.enabled);
  }


  function drawCustomDataItems(selection) {
    const dataLayer = scene.layers.get('custom-data');
    const hasData = dataLayer && dataLayer.hasData();
    const showsData = hasData && dataLayer.enabled;
    const isRTL = l10n.isRTL();

    let ul = selection
      .selectAll('.layer-list-data')
      .data(dataLayer ? [0] : []);

    // Exit
    ul.exit()
      .remove();

    // Enter
    let ulEnter = ul.enter()
      .append('ul')
      .attr('class', 'layer-list layer-list-data');

    let liEnter = ulEnter
      .append('li')
      .attr('class', 'list-item-data');

    let labelEnter = liEnter
      .append('label')
      .call(uiTooltip(context)
        .title(l10n.tHtml('map_data.layers.custom.tooltip'))
        .placement('top')
      );

    labelEnter
      .append('input')
      .attr('type', 'checkbox')
      .on('change', () => toggleLayer('custom-data'));

    labelEnter
      .append('span')
      .html(l10n.tHtml('map_data.layers.custom.title'));

    liEnter
      .append('button')
      .attr('class', 'open-data-options')
      .call(uiTooltip(context)
        .title(l10n.tHtml('settings.custom_data.tooltip'))
        .placement(isRTL ? 'right' : 'left')
      )
      .on('click', d3_event => {
        d3_event.preventDefault();
        editCustom();
      })
      .call(uiIcon('#rapid-icon-more'));

    liEnter
      .append('button')
      .attr('class', 'zoom-to-data')
      .call(uiTooltip(context)
        .title(l10n.tHtml('map_data.layers.custom.zoom'))
        .placement(isRTL ? 'right' : 'left')
      )
      .on('click', function(d3_event) {
        if (d3_select(this).classed('disabled')) return;

        d3_event.preventDefault();
        d3_event.stopPropagation();
        dataLayer.fitZoom();
      })
      .call(uiIcon('#rapid-icon-framed-dot', 'monochrome'));

    // Update
    ul = ul
      .merge(ulEnter);

    ul.selectAll('.list-item-data')
      .classed('active', showsData)
      .selectAll('label')
      .classed('deemphasize', !hasData)
      .selectAll('input')
      .property('disabled', !hasData)
      .property('checked', showsData);

    ul.selectAll('button.zoom-to-data')
      .classed('disabled', !hasData);
  }


  function editCustom() {
    context.container()
      .call(settingsCustomData);
  }


  function customChanged(d) {
    const dataLayer = scene.layers.get('custom-data');

    if (d && d.url) {
      dataLayer.url(d.url);
    } else if (d && d.fileList) {
      dataLayer.fileList(d.fileList);
    }
  }


  function drawPanelItems(selection) {
    let panelsListEnter = selection.selectAll('.md-extras-list')
      .data([0])
      .enter()
      .append('ul')
      .attr('class', 'layer-list md-extras-list');

    let historyPanelLabelEnter = panelsListEnter
      .append('li')
      .attr('class', 'history-panel-toggle-item')
      .append('label')
      .call(uiTooltip(context)
        .title(l10n.tHtml('map_data.history_panel.tooltip'))
        .keys([uiCmd('⌘⇧' + l10n.t('info_panels.history.key'))])
        .placement('top')
      );

    historyPanelLabelEnter
      .append('input')
      .attr('type', 'checkbox')
      .on('change', d3_event => {
        d3_event.preventDefault();
        context.systems.ui.info.toggle('history');
      });

    historyPanelLabelEnter
      .append('span')
      .html(l10n.tHtml('map_data.history_panel.title'));

    let measurementPanelLabelEnter = panelsListEnter
      .append('li')
      .attr('class', 'measurement-panel-toggle-item')
      .append('label')
      .call(uiTooltip(context)
        .title(l10n.tHtml('map_data.measurement_panel.tooltip'))
        .keys([uiCmd('⌘⇧' + l10n.t('info_panels.measurement.key'))])
        .placement('top')
      );

    measurementPanelLabelEnter
      .append('input')
      .attr('type', 'checkbox')
      .on('change', d3_event => {
        d3_event.preventDefault();
        context.systems.ui.info.toggle('measurement');
      });

    measurementPanelLabelEnter
      .append('span')
      .html(l10n.tHtml('map_data.measurement_panel.title'));
  }


  context.scene().on('layerchange', section.reRender);

  return section;
}
