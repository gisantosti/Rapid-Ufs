import * as PIXI from 'pixi.js';
import _throttle from 'lodash-es/throttle';

import { select as d3_select } from 'd3-selection';
import { dispatch as d3_dispatch } from 'd3-dispatch';

import { modeBrowse } from '../modes/browse';
import { services } from '../services';


var _notesEnabled = false;
var _osmService;

export function pixiNotes(context, featureCache, dispatch) {

    if (!dispatch) { dispatch = d3_dispatch('change'); }
    var throttledRedraw = _throttle(function () { dispatch.call('change'); }, 1000);
    var minZoom = 12;
    var _notesVisible = false;
    let _textures = {};
    let _didInit = false;

    function initNotesTextures() {
        const marker = new PIXI.Graphics()
            .lineStyle(1.5, 0x333333)
            .beginFill(0xff3300, 1)
            // Draw the 'word balloon'
            .moveTo(17.5, 0)
            .lineTo(2.5,0)
            .bezierCurveTo(1.13, 0, 0, 1.12, 0, 2.5)
            .lineTo(0, 13.75)
            .bezierCurveTo(0, 15.12, 1.12, 16.25, 2.5, 16.25)
            .lineTo(6.25, 16.25)
            .lineTo(6.25, 19.53)
            .bezierCurveTo(6.25, 19.91, 6.68, 20.13, 7, 19.9)
            .lineTo(11.87, 16.25)
            .lineTo(17.49, 16.25)
            .bezierCurveTo(18.86, 16.25, 20, 15.12, 20, 13.75)
            .lineTo(20, 2.5)
            .bezierCurveTo(20, 1.13, 18.87, 0, 17.5, 0)
            // Now draw the 'x' in the middle of the balloon
            .moveTo(7, 5)
            .lineTo(14, 12)
            .moveTo(14, 5)
            .lineTo(7,12)
            .closePath()
            .endFill();

        const ellipse = new PIXI.Graphics()
            .lineStyle(1, 0x222222, 0.6)
            .beginFill(0x222222, 0.6)
            .drawEllipse(0.5, 1, 6.5, 3)
            .endFill();

        const renderer = context.pixi.renderer;
        const options = { resolution: 2 };
        _textures.marker = renderer.generateTexture(marker, options);
        _textures.oval = renderer.generateTexture(ellipse, options);
        _didInit = true;

    }


    // Loosely-coupled osm service for fetching notes.
    function getService() {
        if (services.osm && !_osmService) {
            _osmService = services.osm;
            _osmService.on('loadedNotes', throttledRedraw);
        } else if (!services.osm && _osmService) {
            _osmService = null;
        }

        return _osmService;
    }


    // Show the notes
    function editOn() {
        if (!_notesVisible) {
            _notesVisible = true;
            context.pixi.stage.getChildByName('notes').visible = true;
        }
    }


    // Immediately remove the notes and their touch targets
    function editOff() {
        if (_notesVisible) {
            _notesVisible = false;
            context.pixi.stage.getChildByName('notes').visible = false;
        }
    }


    // Enable the layer.  This shows the notes and transitions them to visible.
    function layerOn() {
        editOn();
        dispatch.call('change');
    }


    // Disable the layer.  This transitions the layer invisible and then hides the notes.
    function layerOff() {
        throttledRedraw.cancel();
        editOff();
        dispatch.call('change');
    }


    // Update the note markers
    function updateMarkers(layer, projection) {
        if (!_notesVisible || !_notesEnabled) return;
        const k = projection.scale();

        var service = getService();
        var selectedID = context.selectedNoteID();
        const entities = (service ? service.notes(context.projection) : []);

        entities.forEach(function prepareNotes(note) {
            let feature = featureCache.get(note.id);

            if (!feature) {   // make point if needed
                const container = new PIXI.Container();
                container.name = 'note-' + note.id;
                layer.addChild(container);

                const noteMarker = new PIXI.Sprite(_textures.marker);
                noteMarker.name = 'marker';
                noteMarker.anchor.set(0.5, 1);
                container.addChild(noteMarker);

                const oval = new PIXI.Sprite(_textures.oval);
                oval.name = 'oval';
                oval.anchor.set(0.5, 0);
                oval.x = -2;
                container.addChild(oval);

                feature = {
                    displayObject: container,
                    loc: note.loc,
                    marker: noteMarker
                };

                featureCache.set(note.id, feature);
            }

            if (k === feature.k) return;
            feature.k = k;

            // Reproject and recalculate the bounding box
            const [x, y] = projection.project(feature.loc);
            feature.displayObject.position.set(x, y);
        });


        function sortY(a, b) {
            if (a.id === selectedID) return 1;
            if (b.id === selectedID) return -1;
            return b.loc[1] - a.loc[1];
        }
    }


    // Draw the notes layer and schedule loading notes and updating markers.
    function drawNotes(layer, projection) {

        if (!_didInit) initNotesTextures();

        var service = getService();


        if (_notesEnabled) {
            if (service && ~~context.map().zoom() >= minZoom) {
                editOn();
                service.loadNotes(context.projection);
                updateMarkers(layer, projection);
            } else {
                editOff();
            }
        }
    }


    // Toggles the layer on and off
    drawNotes.enabled = function(val) {
        if (!arguments.length) return _notesEnabled;

        _notesEnabled = val;
        if (_notesEnabled) {
            layerOn();
        } else {
            layerOff();
            if (context.selectedNoteID()) {
                context.enter(modeBrowse(context));
            }
        }

        dispatch.call('change');
        return this;
    };


    return drawNotes;
}
