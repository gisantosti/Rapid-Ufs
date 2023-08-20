import { dispatch as d3_dispatch } from 'd3-dispatch';
import { select as d3_select } from 'd3-selection';
import { utilArrayGroupBy, utilUniqueString } from '@rapid-sdk/util';
import deepEqual from 'fast-deep-equal';

import { osmChangeset } from '../osm';
import { uiIcon } from './icon';
import { uiTooltip } from './tooltip';
import { uiChangesetEditor } from './changeset_editor';
import { uiSectionChanges } from './sections/changes';
import { uiCommitWarnings } from './commit_warnings';
import { uiSectionRawTagEditor } from './sections/raw_tag_editor';
import { utilDetect, utilRebind } from '../util';


const readOnlyTags = [
  /^changesets_count$/,
  /^created_by$/,
  /^ideditor:/,
  /^imagery_used$/,
  /^host$/,
  /^locale$/,
  /^poweruser$/,
  /^warnings:/,
  /^resolved:/,
  /^closed:note$/,
  /^closed:keepright$/,
  /^closed:improveosm:/,
  /^closed:osmose:/
];

// treat most punctuation (except -, _, +, &) as hashtag delimiters - iD#4398
// from https://stackoverflow.com/a/25575009
const hashtagRegex = /(#[^\u2000-\u206F\u2E00-\u2E7F\s\\'!"#$%()*,.\/:;<=>?@\[\]^`{|}~]+)/g;


export function uiCommit(context) {
  const rapid = context.systems.rapid;
  const storage = context.systems.storage;
  const uploader = context.systems.uploader;

  const dispatch = d3_dispatch('cancel');
  let _userDetails;
  let _selection;

  const changesetEditor = uiChangesetEditor(context)
    .on('change', changeTags);
  const rawTagEditor = uiSectionRawTagEditor(context, 'changeset-tag-editor')
    .on('change', changeTags)
    .readOnlyTags(readOnlyTags);
  const commitChanges = uiSectionChanges(context);
  const commitWarnings = uiCommitWarnings(context);


  function commit(selection) {
    _selection = selection;

    // Initialize changeset if one does not exist yet.
    if (!uploader.changeset) initChangeset();

    updateSessionChangesetTags();
    selection.call(render);
  }


  //
  // Creates an initial changeset
  //
  function initChangeset() {
    const localeCode = context.systems.l10n.localeCode();

    // Expire stored comment, hashtags, source after cutoff datetime - iD#3947 iD#4899
    const commentDate = +storage.getItem('commentDate') || 0;
    const currDate = Date.now();
    const cutoff = 2 * 86400 * 1000;   // 2 days
    if (commentDate > currDate || currDate - commentDate > cutoff) {
      storage.removeItem('comment');
      storage.removeItem('hashtags');
      storage.removeItem('source');
    }

    // Override with any `comment`,`source`,`hashtags` that we got from the urlhash, if any
    const urlhash = context.systems.urlhash;
    const defaultChangesetComment = urlhash.initialHashParams.get('comment');
    const defaultChangesetSource = urlhash.initialHashParams.get('source');
    const defaultChangesetHashtags = urlhash.initialHashParams.get('hashtags');

    if (defaultChangesetComment) {
      storage.setItem('comment', defaultChangesetComment);
      storage.setItem('commentDate', Date.now());
    }
    if (defaultChangesetSource) {
      storage.setItem('source', defaultChangesetSource);
      storage.setItem('commentDate', Date.now());
    }
    if (defaultChangesetHashtags) {
      storage.setItem('hashtags', defaultChangesetHashtags);
      storage.setItem('commentDate', Date.now());
    }

    const detected = utilDetect();
    let tags = {
      comment: storage.getItem('comment') || '',
      created_by: context.cleanTagValue('Rapid ' + context.version),
      host: context.cleanTagValue(detected.host),
      locale: context.cleanTagValue(localeCode)
    };

    // Call findHashtags initially - this will remove stored
    // hashtags if any hashtags are found in the comment - iD#4304
    findHashtags(tags, true);

    let hashtags = storage.getItem('hashtags');
    if (hashtags) {
      tags.hashtags = hashtags;
    }

    let source = storage.getItem('source');
    if (source) {
      tags.source = source;
    }

    uploader.changeset = new osmChangeset({ tags: tags });
  }


  //
  // Calculates tags based on the user's editing session
  //
  function updateSessionChangesetTags() {
    const osm = context.services.osm;
    if (!osm) return;

    let tags = Object.assign({}, uploader.changeset.tags);   // shallow copy
    let sources = new Set((tags.source || '').split(';'));

    // Sync up the poweruser tag
    // Set to true if the user had poweruser on at any point during their editing
    if (rapid.hadPoweruser) {
      tags.poweruser = 'true';
    } else {
      delete tags.poweruser;
    }

    // Sync up the used photo sources with `sources`
    let usedPhotos = new Set(context.systems.edits.photosUsed());
    let allPhotos = ['streetside', 'mapillary', 'mapillary-map-features', 'mapillary-signs', 'kartaview'];
    allPhotos.forEach(function(val) { sources.delete(val); });   // reset all
    if (usedPhotos.size) {
      sources.add('streetlevel imagery');
      usedPhotos.forEach(function(val) { sources.add(val); });
    } else {
      sources.delete('streetlevel imagery');
    }

    // Sync up the used Rapid sources with `sources`
    let usedRapid = rapid.sources;
    let allRapid = ['mapwithai', 'esri'];
    allRapid.forEach(function(val) { sources.delete(val); });   // reset all
    usedRapid.forEach(function(val) { sources.add(val); });

    // Update `source` tag
    let setSource = context.cleanTagValue(Array.from(sources).filter(Boolean).join(';'));
    if (setSource) {
      tags.source = setSource;
    } else {
      delete tags.source;
    }

    // Update `imagery_used` tag
    let imageries = new Set(context.systems.edits.imageryUsed());
    let setImagery = context.cleanTagValue(Array.from(imageries).filter(Boolean).join(';'));
    tags.imagery_used = setImagery || 'None';

    // Update tags for closed issues and notes
    const osmClosed = osm.getClosedIDs();
    if (osmClosed.length) {
      tags['closed:note'] = context.cleanTagValue(osmClosed.join(';'));
    }
    const keepright = context.services.keepRight;
    if (keepright) {
      const krClosed = keepright.getClosedIDs();
      if (krClosed.length) {
        tags['closed:keepright'] = context.cleanTagValue(krClosed.join(';'));
      }
    }
    const improveosm = context.services.improveOSM;
    if (improveosm) {
      const iOsmClosed = improveosm.getClosedCounts();
      for (let itemType in iOsmClosed) {
        tags[`closed:improveosm:${itemType}`] = context.cleanTagValue(iOsmClosed[itemType].toString());
      }
    }
    const osmose = context.services.osmose;
    if (osmose) {
      const osmoseClosed = osmose.getClosedCounts();
      for (let itemType in osmoseClosed) {
        tags[`closed:osmose:${itemType}`] = context.cleanTagValue(osmoseClosed[itemType].toString());
      }
    }

    // Remove existing issue counts
    for (let key in tags) {
      if (key.match(/(^warnings:)|(^resolved:)/)) {
        delete tags[key];
      }
    }

    function addIssueCounts(issues, prefix) {
      let issuesByType = utilArrayGroupBy(issues, 'type');
      for (let issueType in issuesByType) {
        let issuesOfType = issuesByType[issueType];
        if (issuesOfType[0].subtype) {
          let issuesBySubtype = utilArrayGroupBy(issuesOfType, 'subtype');
          for (let issueSubtype in issuesBySubtype) {
            let issuesOfSubtype = issuesBySubtype[issueSubtype];
            tags[prefix + ':' + issueType + ':' + issueSubtype] = context.cleanTagValue(issuesOfSubtype.length.toString());
          }
        } else {
          tags[prefix + ':' + issueType] = context.cleanTagValue(issuesOfType.length.toString());
        }
      }
    }

    // Add counts of warnings generated by the user's edits
    const warnings = context.systems.validator
      .getIssuesBySeverity({ what: 'edited', where: 'all', includeIgnored: true, includeDisabledRules: true })
      .warning
      .filter(issue => issue.type !== 'help_request');    // exclude 'fixme' and similar - iD#8603

    addIssueCounts(warnings, 'warnings');

    // add counts of issues resolved by the user's edits
    const resolvedIssues = context.systems.validator.getResolvedIssues();
    addIssueCounts(resolvedIssues, 'resolved');

    uploader.changeset = uploader.changeset.update({ tags: tags });
  }


  //
  //
  function render(selection) {
    const osm = context.services.osm;
    if (!osm) return;

    let header = selection.selectAll('.header')
      .data([0]);

    let headerTitle = header.enter()
      .append('div')
      .attr('class', 'header fillL');

    headerTitle
      .append('div')
      .append('h3')
      .html(context.tHtml('commit.title'));

    headerTitle
      .append('button')
      .attr('class', 'close')
      .on('click', function() {
        dispatch.call('cancel', this);
      })
      .call(uiIcon('#rapid-icon-close'));

    let body = selection.selectAll('.body')
      .data([0]);

    body = body.enter()
      .append('div')
      .attr('class', 'body')
      .merge(body);


    // Changeset Section
    let changesetSection = body.selectAll('.changeset-editor')
      .data([0]);

    changesetSection = changesetSection.enter()
      .append('div')
      .attr('class', 'modal-section changeset-editor')
      .merge(changesetSection);

    changesetSection
      .call(changesetEditor
        .changesetID(uploader.changeset.id)
        .tags(uploader.changeset.tags)
      );


    // Warnings
    body.call(commitWarnings);


    // Upload Explanation
    let saveSection = body.selectAll('.save-section')
      .data([0]);

    saveSection = saveSection.enter()
      .append('div')
      .attr('class','modal-section save-section fillL')
      .merge(saveSection);

    let prose = saveSection.selectAll('.commit-info')
      .data([0]);

    if (prose.enter().size()) {   // first time, make sure to update user details in prose
      _userDetails = null;
    }

    prose = prose.enter()
      .append('p')
      .attr('class', 'commit-info')
      .html(context.tHtml('commit.upload_explanation'))
      .merge(prose);

    // Always check if this has changed, but only update prose.html()
    // if needed, because it can trigger a style recalculation
    osm.userDetails(function(err, user) {
      if (err) return;

      if (_userDetails === user) return;  // no change
      _userDetails = user;

      let userLink = d3_select(document.createElement('div'));

      if (user.image_url) {
        userLink
          .append('img')
          .attr('src', user.image_url)
          .attr('class', 'icon pre-text user-icon');
      }

      userLink
        .append('a')
        .attr('class', 'user-info')
        .html(user.display_name)
        .attr('href', osm.userURL(user.display_name))
        .attr('target', '_blank');

      prose
        .html(context.tHtml('commit.upload_explanation_with_user', { user: userLink.html() }));
    });


    // Request Review
    let requestReview = saveSection.selectAll('.request-review')
      .data([0]);

    // Enter
    let requestReviewEnter = requestReview.enter()
      .append('div')
      .attr('class', 'request-review');

    let requestReviewDomId = utilUniqueString('commit-input-request-review');

    let labelEnter = requestReviewEnter
      .append('label')
      .attr('for', requestReviewDomId);

    if (!labelEnter.empty()) {
      labelEnter
        .call(uiTooltip(context).title(context.tHtml('commit.request_review_info')).placement('top'));
    }

    labelEnter
      .append('input')
      .attr('type', 'checkbox')
      .attr('id', requestReviewDomId);

    labelEnter
      .append('span')
      .html(context.tHtml('commit.request_review'));

    // Update
    requestReview = requestReview
      .merge(requestReviewEnter);

    let requestReviewInput = requestReview.selectAll('input')
      .property('checked', isReviewRequested(uploader.changeset.tags))
      .on('change', toggleRequestReview);


    // Buttons
    let buttonSection = saveSection.selectAll('.buttons')
      .data([0]);

    // enter
    let buttonEnter = buttonSection.enter()
      .append('div')
      .attr('class', 'buttons fillL');

    buttonEnter
      .append('button')
      .attr('class', 'secondary-action button cancel-button')
      .append('span')
      .attr('class', 'label')
      .html(context.tHtml('commit.cancel'));

    let uploadButton = buttonEnter
      .append('button')
      .attr('class', 'action button save-button');

    uploadButton.append('span')
      .attr('class', 'label')
      .html(context.tHtml('commit.save'));

    let uploadBlockerTooltipText = getUploadBlockerMessage();

    // update
    buttonSection = buttonSection
      .merge(buttonEnter);

    buttonSection.selectAll('.cancel-button')
      .on('click.cancel', function() {
        dispatch.call('cancel', this);
      });

    buttonSection.selectAll('.save-button')
      .classed('disabled', uploadBlockerTooltipText !== null)
      .on('click.save', function() {
        if (!d3_select(this).classed('disabled')) {
          this.blur();    // avoid keeping focus on the button - iD#4641

          for (let key in uploader.changeset.tags) {
            // remove any empty keys before upload
            if (!key) delete uploader.changeset.tags[key];
          }

          uploader.save();
        }
      });

    // remove any existing tooltip
    uiTooltip(context).destroyAny(buttonSection.selectAll('.save-button'));

    if (uploadBlockerTooltipText) {
      buttonSection.selectAll('.save-button')
        .call(uiTooltip(context).title(uploadBlockerTooltipText).placement('top'));
    }

    // Raw Tag Editor
    let tagSection = body.selectAll('.tag-section.raw-tag-editor')
      .data([0]);

    tagSection = tagSection.enter()
      .append('div')
      .attr('class', 'modal-section tag-section raw-tag-editor')
      .merge(tagSection);

    tagSection
      .call(rawTagEditor
        .tags(Object.assign({}, uploader.changeset.tags))   // shallow copy
        .render
      );

    let changesSection = body.selectAll('.commit-changes-section')
      .data([0]);

    changesSection = changesSection.enter()
      .append('div')
      .attr('class', 'modal-section commit-changes-section')
      .merge(changesSection);

    // Change summary
    changesSection.call(commitChanges.render);


    function toggleRequestReview() {
      const rr = requestReviewInput.property('checked');
      updateChangeset({ review_requested: (rr ? 'yes' : undefined) });

      tagSection
        .call(rawTagEditor
          .tags(Object.assign({}, uploader.changeset.tags))   // shallow copy
          .render
        );
    }
  }


  function getUploadBlockerMessage() {
    const errors = context.systems.validator
      .getIssuesBySeverity({ what: 'edited', where: 'all' }).error;

    if (errors.length) {
      return context.t('commit.outstanding_errors_message', { count: errors.length });

    } else {
      const comment = uploader.changeset?.tags?.comment ?? '';
      if (!comment.trim().length) {
        return context.t('commit.comment_needed_message');
      }
    }
    return null;
  }


  function changeTags(_, changed, onInput) {
    if (changed.hasOwnProperty('comment')) {
      if (changed.comment === undefined) {
        changed.comment = '';
      }
      if (!onInput) {
        storage.setItem('comment', changed.comment);
        storage.setItem('commentDate', Date.now());
      }
    }
    if (changed.hasOwnProperty('source')) {
      if (changed.source === undefined) {
        storage.removeItem('source');
      } else if (!onInput) {
        storage.setItem('source', changed.source);
        storage.setItem('commentDate', Date.now());
      }
    }
    // no need to update `storage` for `hashtags` here since it's done in `updateChangeset`

    updateChangeset(changed, onInput);

    if (_selection) {
      _selection.call(render);
    }
  }


  function findHashtags(tags, commentOnly) {
    let detectedHashtags = commentHashtags();

    // always remove stored hashtags if there are hashtags in the comment - iD#4304
    if (detectedHashtags.length) {
      storage.removeItem('hashtags');
    }
    if (!detectedHashtags.length || !commentOnly) {
      detectedHashtags = detectedHashtags.concat(hashtagHashtags());
    }

    let allLowerCase = new Set();
    return detectedHashtags.filter(hashtag => {
      // Compare tags as lowercase strings, but keep original case tags
      const lowerCase = hashtag.toLowerCase();
      if (!allLowerCase.has(lowerCase)) {
        allLowerCase.add(lowerCase);
        return true;
      }
      return false;
    });

    // Extract hashtags from `comment`
    function commentHashtags() {
      let matches = (tags.comment || '')
        .replace(/http\S*/g, '')  // drop anything that looks like a URL - iD#4289
        .match(hashtagRegex);

      return matches || [];
    }

    // Extract and clean hashtags from `hashtags`
    function hashtagHashtags() {
      let matches = (tags.hashtags || '')
        .split(/[,;\s]+/)
        .map(function (s) {
          if (s[0] !== '#') { s = '#' + s; }    // prepend '#'
          let matched = s.match(hashtagRegex);
          return matched && matched[0];
        }).filter(Boolean);                       // exclude falsy

      return matches || [];
    }
  }


  function isReviewRequested(tags) {
    let rr = tags.review_requested;
    if (rr === undefined) return false;
    rr = rr.trim().toLowerCase();
    return !(rr === '' || rr === 'no');
  }


  function updateChangeset(changed, onInput) {
    let tags = Object.assign({}, uploader.changeset.tags);   // shallow copy

    Object.keys(changed).forEach(function(k) {
      let v = changed[k];
      k = context.cleanTagKey(k);
      if (readOnlyTags.indexOf(k) !== -1) return;

      if (v === undefined) {
        delete tags[k];
      } else if (onInput) {
        tags[k] = v;
      } else {
        tags[k] = context.cleanTagValue(v);
      }
    });

    if (!onInput) {
      // when changing the comment, override hashtags with any found in comment.
      const commentOnly = changed.hasOwnProperty('comment') && (changed.comment !== '');
      const arr = findHashtags(tags, commentOnly);
      if (arr.length) {
        tags.hashtags = context.cleanTagValue(arr.join(';'));
        storage.setItem('hashtags', tags.hashtags);
      } else {
        delete tags.hashtags;
        storage.removeItem('hashtags');
      }
    }

    // always update userdetails, just in case user reauthenticates as someone else
    if (_userDetails && _userDetails.changesets_count !== undefined) {
      let changesetsCount = parseInt(_userDetails.changesets_count, 10) + 1;  // iD#4283
      tags.changesets_count = String(changesetsCount);

      // first 100 edits - new user
      if (changesetsCount <= 100) {
        let s;
        s = storage.getItem('walkthrough_completed');
        if (s) {
          tags['ideditor:walkthrough_completed'] = s;
        }

        s = storage.getItem('walkthrough_progress');
        if (s) {
          tags['ideditor:walkthrough_progress'] = s;
        }

        s = storage.getItem('walkthrough_started');
        if (s) {
          tags['ideditor:walkthrough_started'] = s;
        }
      }
    } else {
      delete tags.changesets_count;
    }

    if (!deepEqual(uploader.changeset.tags, tags)) {
      uploader.changeset = uploader.changeset.update({ tags: tags });
    }
  }


  return utilRebind(commit, dispatch, 'on');
}
