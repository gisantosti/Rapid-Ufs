import { dispatch as d3_dispatch } from 'd3-dispatch';
import { utilArrayUniqBy } from '@rapid-sdk/util';

import { uiIcon } from './icon';
import { uiCombobox} from './combobox';
import { UiField } from './UiField';
import { uiFormFields } from './form_fields';
import { utilRebind, utilTriggerEvent } from '../util';


export function uiChangesetEditor(context) {
    var dispatch = d3_dispatch('change');
    var formFields = uiFormFields(context);
    var commentCombo = uiCombobox(context, 'comment').caseSensitive(true);
    var _uifields;
    var _tags;
    var _changesetID;


    function changesetEditor(selection) {
        render(selection);
    }


    function render(selection) {
        var initial = false;

        if (!_uifields) {
            initial = true;
            var presetSysetem = context.systems.presets;

            _uifields = [
                new UiField(context, presetSysetem.field('comment'), null, { show: true, revert: false }),
                new UiField(context, presetSysetem.field('source'), null, { show: false, revert: false }),
                new UiField(context, presetSysetem.field('hashtags'), null, { show: false, revert: false }),
            ];

            _uifields.forEach(function(field) {
                field
                    .on('change', function(t, onInput) {
                        dispatch.call('change', field, undefined, t, onInput);
                    });
            });
        }

        _uifields.forEach(function(field) {
            field
                .tags(_tags);
        });


        selection
            .call(formFields.fieldsArr(_uifields));


        if (initial) {
            var commentField = selection.select('.form-field-comment textarea');
            var commentNode = commentField.node();

            if (commentNode) {
                commentNode.focus();
                commentNode.select();
            }

            // trigger a 'blur' event so that comment field can be cleaned
            // and checked for hashtags, even if retrieved from localstorage
            utilTriggerEvent(commentField, 'blur');

            var osm = context.services.osm;
            if (osm) {
                osm.userChangesets(function (err, changesets) {
                    if (err) return;

                    var comments = changesets.map(function(changeset) {
                        var comment = changeset.tags.comment;
                        return comment ? { title: comment, value: comment } : null;
                    }).filter(Boolean);

                    commentField
                        .call(commentCombo
                            .data(utilArrayUniqBy(comments, 'title'))
                        );
                });
            }
        }

        // Add warning if comment mentions Google
        var hasGoogle = _tags.comment.match(/google/i);
        var commentWarning = selection.select('.form-field-comment').selectAll('.comment-warning')
            .data(hasGoogle ? [0] : []);

        commentWarning.exit()
            .transition()
            .duration(200)
            .style('opacity', 0)
            .remove();

        var commentEnter = commentWarning.enter()
            .insert('div', '.tag-reference-body')
            .attr('class', 'field-warning comment-warning')
            .style('opacity', 0);

        commentEnter
            .append('a')
            .attr('target', '_blank')
            .call(uiIcon('#rapid-icon-alert', 'inline'))
            .attr('href', context.t('commit.google_warning_link'))
            .append('span')
            .text(context.t('commit.google_warning'));

        commentEnter
            .transition()
            .duration(200)
            .style('opacity', 1);
    }


    changesetEditor.tags = function(_) {
        if (!arguments.length) return _tags;
        _tags = _;
        // Don't reset _uifields here.
        return changesetEditor;
    };


    changesetEditor.changesetID = function(_) {
        if (!arguments.length) return _changesetID;
        if (_changesetID === _) return changesetEditor;
        _changesetID = _;
        _uifields = null;
        return changesetEditor;
    };


    return utilRebind(changesetEditor, dispatch, 'on');
}
