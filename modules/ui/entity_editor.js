import { dispatch as d3_dispatch } from 'd3-dispatch';
import { utilArrayIdentical, utilCleanTags } from '@rapid-sdk/util';
import deepEqual from 'fast-deep-equal';

import { actionChangeTags } from '../actions/change_tags';
import { uiIcon } from './icon';
import { utilRebind } from '../util';

import { uiSectionEntityIssues } from './sections/entity_issues';
import { uiSectionFeatureType } from './sections/feature_type';
import { uiSectionPresetFields } from './sections/preset_fields';
import { uiSectionRawMemberEditor } from './sections/raw_member_editor';
import { uiSectionRawMembershipEditor } from './sections/raw_membership_editor';
import { uiSectionRawTagEditor } from './sections/raw_tag_editor';
import { uiSectionSelectionList } from './sections/selection_list';


export function uiEntityEditor(context) {
    var dispatch = d3_dispatch('choose');
    var _state = 'select';
    var _coalesceChanges = false;
    var _modified = false;
    var _base;
    var _entityIDs;
    var _activePresets = [];
    var _newFeature;

    var _sections;
    var _init = false;

    // Returns a single object containing the tags of all the given entities.
    // Example:
    // {
    //   highway: 'service',
    //   service: 'parking_aisle'
    // }
    //           +
    // {
    //   highway: 'service',
    //   service: 'driveway',
    //   width: '3'
    // }
    //           =
    // {
    //   highway: 'service',
    //   service: [ 'driveway', 'parking_aisle' ],
    //   width: [ '3', undefined ]
    // }
    function getCombinedTags(entityIDs, graph) {
        var tags = {};
        var tagCounts = {};
        var allKeys = new Set();

        var entities = entityIDs.map(function(entityID) {
            return graph.hasEntity(entityID);
        }).filter(Boolean);

        // gather the aggregate keys
        entities.forEach(function(entity) {
            var keys = Object.keys(entity.tags).filter(Boolean);
            keys.forEach(function(key) {
                allKeys.add(key);
            });
        });

        entities.forEach(function(entity) {

            allKeys.forEach(function(key) {

                var value = entity.tags[key]; // purposely allow `undefined`

                if (!tags.hasOwnProperty(key)) {
                    // first value, set as raw
                    tags[key] = value;
                } else {
                    if (!Array.isArray(tags[key])) {
                        if (tags[key] !== value) {
                            // first alternate value, replace single value with array
                            tags[key] = [tags[key], value];
                        }
                    } else { // type is array
                        if (tags[key].indexOf(value) === -1) {
                            // subsequent alternate value, add to array
                            tags[key].push(value);
                        }
                    }
                }

                var tagHash = key + '=' + value;
                if (!tagCounts[tagHash]) tagCounts[tagHash] = 0;
                tagCounts[tagHash] += 1;
            });
        });

        for (var key in tags) {
            if (!Array.isArray(tags[key])) continue;

            // sort values by frequency then alphabetically
            tags[key] = tags[key].sort(function(val1, val2) {
                var key = key; // capture
                var count2 = tagCounts[key + '=' + val2];
                var count1 = tagCounts[key + '=' + val1];
                if (count2 !== count1) {
                    return count2 - count1;
                }
                if (val2 && val1) {
                    return val1.localeCompare(val2);
                }
                return val1 ? 1 : -1;
            });
        }

        return tags;
    }


    function entityEditor(selection) {
        var combinedTags = getCombinedTags(_entityIDs, context.graph());
        const isRTL = context.systems.l10n.isRTL();

        // Header
        var header = selection.selectAll('.header')
            .data([0]);

        // Enter
        var headerEnter = header.enter()
            .append('div')
            .attr('class', 'header fillL');

        headerEnter
            .append('button')
            .attr('class', 'preset-reset preset-choose')
            .call(uiIcon(isRTL ? '#rapid-icon-forward' : '#rapid-icon-backward'));

        headerEnter
            .append('button')
            .attr('class', 'close')
            .on('click', function() { context.enter('browse'); })
            .call(uiIcon(_modified ? '#rapid-icon-apply' : '#rapid-icon-close'));

        headerEnter
            .append('h3');

        // Update
        header = header
            .merge(headerEnter);

        header.selectAll('h3')
            .html(_entityIDs.length === 1 ? context.tHtml('inspector.edit') : context.tHtml('rapid_multiselect'));

        header.selectAll('.preset-reset')
            .on('click', function() {
                dispatch.call('choose', this, _activePresets);
            });

        // Body
        var body = selection.selectAll('.inspector-body')
            .data([0]);

        // Enter
        var bodyEnter = body.enter()
            .append('div')
            .attr('class', 'entity-editor inspector-body');

        // Update
        body = body
            .merge(bodyEnter);

        if (!_sections) {
            _sections = [
                uiSectionSelectionList(context),
                uiSectionFeatureType(context).on('choose', function(presets) {
                    dispatch.call('choose', this, presets);
                }),
                uiSectionEntityIssues(context),
                uiSectionPresetFields(context).on('change', changeTags).on('revert', revertTags),
                uiSectionRawTagEditor(context, 'raw-tag-editor').on('change', changeTags),
                uiSectionRawMemberEditor(context),
                uiSectionRawMembershipEditor(context)
            ];
        }

        _sections.forEach(function(section) {
            if (section.entityIDs) {
                section.entityIDs(_entityIDs);
            }
            if (section.presets) {
                section.presets(_activePresets);
            }
            if (section.tags) {
                section.tags(combinedTags);
            }
            if (section.state) {
                section.state(_state);
            }
            body.call(section.render);
        });

        if (!_init) {
            context.systems.edits
            .on('change', _onChange);
            _init = true;
        }

        function _onChange(difference) {
            if (selection.selectAll('.entity-editor').empty()) return;
            if (_state === 'hide') return;
            var significant = !difference ||
                    difference.didChange.properties ||
                    difference.didChange.addition ||
                    difference.didChange.deletion;
            if (!significant) return;

            _entityIDs = _entityIDs.filter(context.hasEntity);
            if (!_entityIDs.length) return;

            var priorActivePreset = _activePresets.length === 1 && _activePresets[0];

            loadActivePresets();

            var graph = context.graph();
            entityEditor.modified(_base !== graph);
            entityEditor(selection);

            if (priorActivePreset && _activePresets.length === 1 && priorActivePreset !== _activePresets[0]) {
                // flash the button to indicate the preset changed
                context.container().selectAll('.entity-editor button.preset-reset .label')
                    .style('background-color', '#fff')
                    .transition()
                    .duration(750)
                    .style('background-color', null);
            }
        }
    }


    // Tag changes that fire on input can all get coalesced into a single
    // history operation when the user leaves the field.  iD#2342
    // Use explicit entityIDs in case the selection changes before the event is fired.
    function changeTags(entityIDs, changed, onInput) {

        var actions = [];
        for (var i in entityIDs) {
            var entityID = entityIDs[i];
            var entity = context.entity(entityID);

            var tags = Object.assign({}, entity.tags);   // shallow copy

            for (var k in changed) {
                if (!k) continue;
                // No op for source=digitalglobe or source=maxar on ML roads. TODO: switch to check on __fbid__
                if (entity.__fbid__ && k === 'source' &&
                    (entity.tags.source === 'digitalglobe' || entity.tags.source === 'maxar')) continue;
                var v = changed[k];
                if (v !== undefined || tags.hasOwnProperty(k)) {
                    tags[k] = v;
                }
            }

            if (!onInput) {
                tags = utilCleanTags(tags);
            }

            if (!deepEqual(entity.tags, tags)) {
                actions.push(actionChangeTags(entityID, tags));
            }
        }

        if (actions.length) {
            var combinedAction = function(graph) {
                actions.forEach(function(action) {
                    graph = action(graph);
                });
                return graph;
            };

            var annotation = context.t('operations.change_tags.annotation');

            if (_coalesceChanges) {
                context.overwrite(combinedAction, annotation);
            } else {
                context.perform(combinedAction, annotation);
                _coalesceChanges = !!onInput;
            }
        }

        // if leaving field (blur event), rerun validation
        if (!onInput) {
            context.systems.validator.validate();
        }
    }

    function revertTags(keys) {
        var actions = [];
        for (var i in _entityIDs) {
            var entityID = _entityIDs[i];

            var original = context.graph().base.entities.get(entityID);
            var changed = {};
            for (var j in keys) {
                var key = keys[j];
                changed[key] = original ? original.tags[key] : undefined;
            }

            var entity = context.entity(entityID);
            var tags = Object.assign({}, entity.tags);   // shallow copy

            for (var k in changed) {
                if (!k) continue;
                var v = changed[k];
                if (v !== undefined || tags.hasOwnProperty(k)) {
                    tags[k] = v;
                }
            }


            tags = utilCleanTags(tags);

            if (!deepEqual(entity.tags, tags)) {
                actions.push(actionChangeTags(entityID, tags));
            }

        }

        if (actions.length) {
            var combinedAction = function(graph) {
                actions.forEach(function(action) {
                    graph = action(graph);
                });
                return graph;
            };

            var annotation = context.t('operations.change_tags.annotation');

            if (_coalesceChanges) {
                context.overwrite(combinedAction, annotation);
            } else {
                context.perform(combinedAction, annotation);
                _coalesceChanges = false;
            }
        }

        context.systems.validator.validate();
    }


    entityEditor.modified = function(val) {
        if (!arguments.length) return _modified;
        _modified = val;
        return entityEditor;
    };


    entityEditor.state = function(val) {
        if (!arguments.length) return _state;
        _state = val;
        return entityEditor;
    };


    entityEditor.entityIDs = function(val) {
        if (!arguments.length) return _entityIDs;

        // always reload these even if the entityIDs are unchanged, since we
        // could be reselecting after something like dragging a node
        _base = context.graph();
        _coalesceChanges = false;

        if (val && _entityIDs && utilArrayIdentical(_entityIDs, val)) return entityEditor;  // exit early if no change

        _entityIDs = val;

        loadActivePresets(true);

        return entityEditor
            .modified(false);
    };


    entityEditor.newFeature = function(val) {
        if (!arguments.length) return _newFeature;
        _newFeature = val;
        return entityEditor;
    };


    function loadActivePresets(isForNewSelection) {
        var presetSystem = context.systems.presets;
        var graph = context.graph();

        var counts = {};

        for (var i in _entityIDs) {
            var entity = graph.hasEntity(_entityIDs[i]);
            if (!entity) return;

            var match = presetSystem.match(entity, graph);

            if (!counts[match.id]) counts[match.id] = 0;
            counts[match.id] += 1;
        }

        var matches = Object.keys(counts).sort(function(p1, p2) {
            return counts[p2] - counts[p1];
        }).map(function(pID) {
            return presetSystem.item(pID);
        });

        if (!isForNewSelection) {
            // A "weak" preset doesn't set any tags. (e.g. "Address")
            var weakPreset = _activePresets.length === 1 &&
                !_activePresets[0].isFallback() &&
                Object.keys(_activePresets[0].addTags || {}).length === 0;
            // Don't replace a weak preset with a fallback preset (e.g. "Point")
            if (weakPreset && matches.length === 1 && matches[0].isFallback()) return;
        }

        entityEditor.presets(matches);
    }

    entityEditor.presets = function(val) {
        if (!arguments.length) return _activePresets;

        // don't reload the same preset
        if (!utilArrayIdentical(val, _activePresets)) {
            _activePresets = val;
        }
        return entityEditor;
    };

    return utilRebind(entityEditor, dispatch, 'on');
}
