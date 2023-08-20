import debounce from 'lodash-es/debounce';

import { uiIcon } from '../icon';
import { uiSection } from '../section';


export function uiSectionValidationStatus(context) {
  const validator = context.systems.validator;

  const section = uiSection(context, 'issues-status')
    .shouldDisplay(sectionShouldDisplay)
    .content(renderContent);


  function sectionShouldDisplay() {
    let issues = validator.getIssues(getOptions());
    return issues.length === 0;
  }

  function getOptions() {
    const prefs = context.systems.storage;
    return {
      what: prefs.getItem('validate-what') || 'edited',
      where: prefs.getItem('validate-where') || 'all'
    };
  }


  function renderContent(selection) {
    let box = selection.selectAll('.box')
      .data([0]);

    let boxEnter = box.enter()
      .append('div')
      .attr('class', 'box');

    boxEnter
      .append('div')
      .call(uiIcon('#rapid-icon-apply', 'pre-text'));

    let noIssuesMessage = boxEnter
      .append('span');

    noIssuesMessage
      .append('strong')
      .attr('class', 'message');

    noIssuesMessage
      .append('br');

    noIssuesMessage
      .append('span')
      .attr('class', 'details');

    renderIgnoredIssuesReset(selection);
    setNoIssuesText(selection);
  }


  function renderIgnoredIssuesReset(selection) {
    let ignoredIssues = validator
      .getIssues({ what: 'all', where: 'all', includeDisabledRules: true, includeIgnored: 'only' });

    let resetIgnored = selection.selectAll('.reset-ignored')
      .data(ignoredIssues.length ? [0] : []);

    // exit
    resetIgnored.exit()
      .remove();

    // enter
    let resetIgnoredEnter = resetIgnored.enter()
      .append('div')
      .attr('class', 'reset-ignored section-footer');

    resetIgnoredEnter
      .append('a')
      .attr('href', '#');

    // update
    resetIgnored = resetIgnored
      .merge(resetIgnoredEnter);

    resetIgnored.select('a')
      .html(context.t('inspector.title_count', { title: context.tHtml('issues.reset_ignored'), count: ignoredIssues.length }));

    resetIgnored.on('click', d3_event => {
      d3_event.preventDefault();
      validator.resetIgnoredIssues();
    });
  }


// todo: check this code, seems very inefficient
  function setNoIssuesText(selection) {
    let opts = getOptions();

    function checkForHiddenIssues(cases) {
      for (let type in cases) {
        let hiddenOpts = cases[type];
        let hiddenIssues = validator.getIssues(hiddenOpts);
        if (hiddenIssues.length) {
          selection.select('.box .details')
            .html(context.tHtml('issues.no_issues.hidden_issues.' + type, { count: hiddenIssues.length.toString() } ));
          return;
        }
      }
      selection.select('.box .details')
        .html(context.tHtml('issues.no_issues.hidden_issues.none'));
    }

    let messageType;

    if (opts.what === 'edited' && opts.where === 'visible') {
      messageType = 'edits_in_view';

      checkForHiddenIssues({
        elsewhere: { what: 'edited', where: 'all' },
        everything_else: { what: 'all', where: 'visible' },
        disabled_rules: { what: 'edited', where: 'visible', includeDisabledRules: 'only' },
        everything_else_elsewhere: { what: 'all', where: 'all' },
        disabled_rules_elsewhere: { what: 'edited', where: 'all', includeDisabledRules: 'only' },
        ignored_issues: { what: 'edited', where: 'visible', includeIgnored: 'only' },
        ignored_issues_elsewhere: { what: 'edited', where: 'all', includeIgnored: 'only' }
      });

    } else if (opts.what === 'edited' && opts.where === 'all') {
      messageType = 'edits';

      checkForHiddenIssues({
        everything_else: { what: 'all', where: 'all' },
        disabled_rules: { what: 'edited', where: 'all', includeDisabledRules: 'only' },
        ignored_issues: { what: 'edited', where: 'all', includeIgnored: 'only' }
      });

    } else if (opts.what === 'all' && opts.where === 'visible') {
      messageType = 'everything_in_view';

      checkForHiddenIssues({
        elsewhere: { what: 'all', where: 'all' },
        disabled_rules: { what: 'all', where: 'visible', includeDisabledRules: 'only' },
        disabled_rules_elsewhere: { what: 'all', where: 'all', includeDisabledRules: 'only' },
        ignored_issues: { what: 'all', where: 'visible', includeIgnored: 'only' },
        ignored_issues_elsewhere: { what: 'all', where: 'all', includeIgnored: 'only' }
      });

    } else if (opts.what === 'all' && opts.where === 'all') {
      messageType = 'everything';

      checkForHiddenIssues({
        disabled_rules: { what: 'all', where: 'all', includeDisabledRules: 'only' },
        ignored_issues: { what: 'all', where: 'all', includeIgnored: 'only' }
      });
    }

    if (opts.what === 'edited' && context.systems.edits.difference().summary().size === 0) {
      messageType = 'no_edits';
    }

    selection.select('.box .message')
      .html(context.tHtml(`issues.no_issues.message.${messageType}`));
  }


  validator.on('validated', () => {
    window.requestIdleCallback(section.reRender);
  });

  context.systems.map.on('draw', debounce(() => {
    window.requestIdleCallback(section.reRender);
  }, 1000));

  return section;
}
