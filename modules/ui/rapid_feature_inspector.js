import { select as d3_select } from 'd3-selection';

import { actionNoop, actionRapidAcceptFeature } from '../actions';
import { uiIcon } from './icon';
import { uiFlash } from './flash';
import { uiTooltip } from './tooltip';
import { uiRapidFirstEditDialog } from './rapid_first_edit_dialog';

const ACCEPT_FEATURES_LIMIT = 50;


export function uiRapidFeatureInspector(context, keybinding) {
  const rapid = context.systems.rapid;
  const urlhash = context.systems.urlhash;
  let _datum;


  function isAddFeatureDisabled() {
    // When task GPX appears in URL, "add roads" is always enabled
    const hasTask = urlhash.initialHashParams.has('gpx');
    if (hasTask) return false;

    // Power users aren't limited by the max features limit
    const isPowerUser = urlhash.getParam('poweruser') === 'true';
    if (isPowerUser) return false;

    const annotations = context.systems.edits.peekAllAnnotations();
    const aiFeatureAccepts = annotations.filter(a => a.type === 'rapid_accept_feature');
    return aiFeatureAccepts.length >= ACCEPT_FEATURES_LIMIT;
  }


  function onAcceptFeature() {
    if (!_datum) return;

    if (isAddFeatureDisabled()) {
      const flash = uiFlash(context)
        .duration(5000)
        .label(context.t(
          'rapid_feature_inspector.option_accept.disabled_flash',
          { n: ACCEPT_FEATURES_LIMIT }
        ));
      flash();
      return;
    }

    // In place of a string annotation, this introduces an "object-style"
    // annotation, where "type" and "description" are standard keys,
    // and there may be additional properties. Note that this will be
    // serialized to JSON while saving undo/redo state in editSystem.save().
    let annotation = {
      type: 'rapid_accept_feature',
      description: context.t('rapid_feature_inspector.option_accept.annotation'),
      id: _datum.id,
      origid: _datum.__origid__
    };

    const service = context.services[_datum.__service__];
    const graph = service.graph(_datum.__datasetid__);
    const sourceTag = _datum.tags && _datum.tags.source;
    if (sourceTag) annotation.source = sourceTag;

    context.perform(actionRapidAcceptFeature(_datum.id, graph), annotation);
    context.enter('select-osm', { selectedIDs: [_datum.id] });

    if (context.inIntro) return;

    // remember sources for later when we prepare the changeset
    rapid.sources.add('mapwithai');    // always add 'mapwithai'
    if (sourceTag && /^esri/.test(sourceTag)) {
      rapid.sources.add('esri');       // add 'esri' for esri sources
    }

    if (window.sessionStorage.getItem('acknowledgedLogin') === 'true') return;
    window.sessionStorage.setItem('acknowledgedLogin', 'true');

    const osm = context.services.osm;
    if (!osm.authenticated()) {
      context.container()
        .call(uiRapidFirstEditDialog(context));
    }
  }


  function onIgnoreFeature() {
    if (!_datum) return;

    const annotation = {
      type: 'rapid_ignore_feature',
      description: context.t('rapid_feature_inspector.option_ignore.annotation'),
      id: _datum.id,
      origid: _datum.__origid__
    };
    context.perform(actionNoop(), annotation);
    context.enter('browse');
  }


  // https://www.w3.org/TR/AERT#color-contrast
  // https://trendct.org/2016/01/22/how-to-choose-a-label-color-to-contrast-with-background/
  // pass color as a hexstring like '#rgb', '#rgba', '#rrggbb', '#rrggbbaa'  (alpha values are ignored)
  function getBrightness(color) {
    const short = (color.length < 6);
    const r = parseInt(short ? color[1] + color[1] : color[1] + color[2], 16);
    const g = parseInt(short ? color[2] + color[2] : color[3] + color[4], 16);
    const b = parseInt(short ? color[3] + color[3] : color[5] + color[6], 16);
    return ((r * 299) + (g * 587) + (b * 114)) / 1000;
  }


  function featureInfo(selection) {
    if (!_datum) return;

    const datasetID = _datum.__datasetid__.replace('-conflated', '');
    const dataset = rapid.datasets.get(datasetID);
    const color = dataset.color;

    let featureInfo = selection.selectAll('.feature-info')
      .data([color]);

    // enter
    let featureInfoEnter = featureInfo
      .enter()
      .append('div')
      .attr('class', 'feature-info');

    featureInfoEnter
      .append('div')
      .attr('class', 'dataset-label')
      .text(dataset.label || dataset.id);   // fallback to dataset ID

    if (dataset.beta) {
      featureInfoEnter
        .append('div')
        .attr('class', 'dataset-beta beta')
        .attr('title', context.t('rapid_poweruser_features.beta'));
    }

    // update
    featureInfo = featureInfo
      .merge(featureInfoEnter)
      .style('background', d => d)
      .style('color', d => getBrightness(d) > 140.5 ? '#333' : '#fff');
  }


  function tagInfo(selection) {
    const tags = _datum && _datum.tags;
    if (!tags) return;

    let tagInfoEnter = selection.selectAll('.tag-info')
      .data([0])
      .enter()
      .append('div')
      .attr('class', 'tag-info');

    let tagBagEnter = tagInfoEnter
      .append('div')
      .attr('class', 'tag-bag');

    tagBagEnter
      .append('div')
      .attr('class', 'tag-heading')
      .text(context.t('rapid_feature_inspector.tags'));

    const tagEntries = Object.keys(tags).map(k => ({ key: k, value: tags[k] }) );

    tagEntries.forEach(e => {
      let entryDiv = tagBagEnter.append('div')
        .attr('class', 'tag-entry');

      entryDiv.append('div').attr('class', 'tag-key').text(e.key);
      entryDiv.append('div').attr('class', 'tag-value').text(e.value);
    });
  }


  function rapidInspector(selection) {
    let inspector = selection.selectAll('.rapid-inspector')
      .data([0]);

    let inspectorEnter = inspector
      .enter()
      .append('div')
      .attr('class', 'rapid-inspector');

    inspector = inspector
      .merge(inspectorEnter);


    // Header
    let headerEnter = inspector.selectAll('.header')
      .data([0])
      .enter()
      .append('div')
      .attr('class', 'header');

    headerEnter
      .append('h3')
      .append('svg')
      // .attr('class', 'logo-rapid dark')
      .attr('class', 'logo-rapid')
      .append('use')
      .attr('xlink:href', '#rapid-logo-rapid-wordmark');

    headerEnter
      .append('button')
      .attr('class', 'fr rapid-inspector-close')
      .on('click', () => {
        context.enter('browse');
      })
      .call(uiIcon('#rapid-icon-close'));


    // Body
    let body = inspector.selectAll('.body')
      .data([0]);

    let bodyEnter = body
      .enter()
      .append('div')
      .attr('class', 'body');

    body = body
      .merge(bodyEnter)
      .call(featureInfo)
      .call(tagInfo);


    // Choices
    const choiceData = [
      {
        key: 'accept',
        iconName: '#rapid-icon-rapid-plus-circle',
        label: context.t('rapid_feature_inspector.option_accept.label'),
        description: context.t('rapid_feature_inspector.option_accept.description'),
        onClick: onAcceptFeature
      }, {
        key: 'ignore',
        iconName: '#rapid-icon-rapid-minus-circle',
        label: context.t('rapid_feature_inspector.option_ignore.label'),
        description: context.t('rapid_feature_inspector.option_ignore.description'),
        onClick: onIgnoreFeature
      }
    ];

    let choices = body.selectAll('.rapid-inspector-choices')
      .data([0]);

    let choicesEnter = choices
      .enter()
      .append('div')
      .attr('class', 'rapid-inspector-choices');

    choicesEnter
      .append('p')
      .text(context.t('rapid_feature_inspector.prompt'));

    choicesEnter.selectAll('.rapid-inspector-choice')
      .data(choiceData, d => d.key)
      .enter()
      .append('div')
      .attr('class', d => `rapid-inspector-choice rapid-inspector-choice-${d.key}`)
      .each(showChoice);
  }


  function showChoice(d, i, nodes) {
    let selection = d3_select(nodes[i]);
    const disableClass = (d.key === 'accept' && isAddFeatureDisabled()) ? 'secondary disabled': '';

    let choiceWrap = selection
      .append('div')
      .attr('class', `choice-wrap choice-wrap-${d.key}`);

    let choiceReference = selection
      .append('div')
      .attr('class', 'tag-reference-body');

    choiceReference
      .text(d.description);

    const onClick = d.onClick;
    let choiceButton = choiceWrap
      .append('button')
      .attr('class', `choice-button choice-button-${d.key} ${disableClass}`)
      .on('click', onClick);

    // build tooltips
    let title, keys;
    if (d.key === 'accept') {
      if (isAddFeatureDisabled()) {
        title = context.t('rapid_feature_inspector.option_accept.disabled', { n: ACCEPT_FEATURES_LIMIT } );
        keys = [];
      } else {
        title = context.t('rapid_feature_inspector.option_accept.tooltip');
        keys = [context.t('rapid_feature_inspector.option_accept.key')];
      }
    } else if (d.key === 'ignore') {
      title = context.t('rapid_feature_inspector.option_ignore.tooltip');
      keys = [context.t('rapid_feature_inspector.option_ignore.key')];
    }

    if (title && keys) {
      choiceButton = choiceButton
        .call(uiTooltip(context).placement('bottom').title(title).keys(keys));
    }

    choiceButton
      .append('svg')
      .attr('class', 'choice-icon icon')
      .append('use')
      .attr('xlink:href', d.iconName);

    choiceButton
      .append('div')
      .attr('class', 'choice-label')
      .text(d.label);

    choiceWrap
      .append('button')
      .attr('class', `tag-reference-button ${disableClass}`)
      .attr('title', 'info')
      .attr('tabindex', '-1')
      .on('click', () => {
        choiceReference.classed('expanded', !choiceReference.classed('expanded'));
      })
      .call(uiIcon('#rapid-icon-inspect'));
  }


  rapidInspector.datum = function(val) {
    if (!arguments.length) return _datum;
    _datum = val;
    return this;
  };

  if (keybinding) {
    keybinding()
      .on(context.t('rapid_feature_inspector.option_accept.key'), onAcceptFeature)
      .on(context.t('rapid_feature_inspector.option_ignore.key'), onIgnoreFeature);
  }

  return rapidInspector;
}
