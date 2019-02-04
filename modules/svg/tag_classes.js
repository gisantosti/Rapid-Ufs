import { select as d3_select } from 'd3-selection';
import { osmPavedTags } from '../osm/tags';


export function svgTagClasses() {
    var primaries = [
        'building', 'highway', 'railway', 'waterway', 'aeroway', 'aerialway',
        'piste:type', 'boundary', 'power', 'amenity', 'natural', 'landuse',
        'leisure', 'military', 'place', 'man_made', 'route', 'attraction'
    ];
    var statuses = [
        'proposed', 'construction', 'disused', 'abandoned', 'dismantled',
        'razed', 'demolished', 'obliterated', 'intermittent'
    ];
    var secondaries = [
        'oneway', 'bridge', 'tunnel', 'embankment', 'cutting', 'barrier',
        'surface', 'tracktype', 'footway', 'crossing', 'service', 'sport',
        'public_transport', 'location', 'parking'
    ];
    var _tags = function(entity) { return entity.tags; };


    var tagClasses = function(selection) {
        selection.each(function tagClassesEach(entity) {
            var value = this.className;
            var primary, status;

            if (value.baseVal !== undefined) {
                value = value.baseVal;
            }

            var t = _tags(entity);
            var i, k, v;

            // in some situations we want to render perimeter strokes a certain way
            var overrideGeometry;
            if (/\bstroke\b/.test(value)) {
                if (!!t.barrier && t.barrier !== 'no') {
                    overrideGeometry = 'line';
                } else if (t.type === 'multipolygon' && !entity.hasInterestingTags()) {
                    overrideGeometry = 'area';
                }
            }

            // preserve base classes (nothing with `tag-`)
            var classes = value.trim().split(/\s+/)
                .filter(function(klass) {
                    return klass.length && !/^tag-/.test(klass);
                })
                .map(function(klass) {  // special overrides for some perimeter strokes
                    return (klass === 'line' || klass === 'area') ? (overrideGeometry || klass) : klass;
                });



            // pick at most one primary classification tag..
            for (i = 0; i < primaries.length; i++) {
                k = primaries[i];
                v = t[k];
                if (!v || v === 'no') continue;

                if (k === 'piste:type') {  // avoid a ':' in the class name
                    k = 'piste';
                }

                primary = k;
                if (statuses.indexOf(v) !== -1) {   // e.g. `railway=abandoned`
                    status = v;
                    classes.push('tag-' + k);
                } else {
                    classes.push('tag-' + k);
                    classes.push('tag-' + k + '-' + v);
                }

                break;
            }

            // add at most one status tag, only if relates to primary tag..
            if (!status) {
                for (i = 0; i < statuses.length; i++) {
                    k = statuses[i];
                    v = t[k];
                    if (!v || v === 'no') continue;

                    if (v === 'yes') {   // e.g. `railway=rail + abandoned=yes`
                        status = k;
                    }
                    else if (primary && primary === v) {  // e.g. `railway=rail + abandoned=railway`
                        status = k;
                    } else if (!primary && primaries.indexOf(v) !== -1) {  // e.g. `abandoned=railway`
                        status = k;
                        primary = v;
                        classes.push('tag-' + v);
                    }  // else ignore e.g.  `highway=path + abandoned=railway`

                    if (status) break;
                }
            }

            if (status) {
                classes.push('tag-status');
                classes.push('tag-status-' + status);
            }

            // add any secondary tags
            for (i = 0; i < secondaries.length; i++) {
                k = secondaries[i];
                v = t[k];
                if (!v || v === 'no') continue;
                classes.push('tag-' + k);
                classes.push('tag-' + k + '-' + v);
            }

            // For highways, look for surface tagging..
            if (primary === 'highway' || primary === 'aeroway') {
                var paved = (t.highway !== 'track');
                for (k in t) {
                    v = t[k];
                    if (k in osmPavedTags) {
                        paved = !!osmPavedTags[k][v];
                        break;
                    }
                }
                if (!paved) {
                    classes.push('tag-unpaved');
                }
            }


            var computed = classes.join(' ').trim();
            if (computed !== value) {
                d3_select(this).attr('class', computed);
            }
        });
    };


    tagClasses.tags = function(val) {
        if (!arguments.length) return _tags;
        _tags = val;
        return tagClasses;
    };

    return tagClasses;
}
