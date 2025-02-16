// Track progress for a specific job, report to discord on changes
const {log,debugLog,sleep, getUUID, getRandomColorDec}=require('../utils.js')
const {resultCache}=require('../resultCache')

update = async (msg, batchid) => {
  // Call once, repetitively update message with results of get(batchid)
  let error = false,
    done = false,
    statusmsg = null,
    cached = null,
    result = null,
    interval = 500,
    fails = 0;
  while (!error && !done) {
    try {
      await sleep(interval);
      result = resultCache.get(batchid);
      statusmsg = returnProgressMessage(batchid);
      if (!statusmsg) {
        fails++;
        if (fails > 3) {
          await msg.delete();
          return;
        }
        continue;
      }
      if (!msg) {
        msg = await channel.createMessage(statusmsg.msg, statusmsg.attachment);
      } else  if (statusmsg && statusmsg !== cached) {
        cached = statusmsg; // update cache
        let messageContent = statusmsg.content;
        if (statusmsg.imageUrl) {
          messageContent += `\n${statusmsg.imageUrl}`;
        }
        if (!msg) {
          msg = await channel.createMessage(messageContent, statusmsg.components);
        } else {
          await msg.edit(messageContent, statusmsg.components);
        }
      }
      if (['completed', 'failed', 'cancelled'].includes(result.status)) {
        await msg.delete();
        return;
      }
    } catch (err) {
      debugLog(err);
      error = true;
    }
  }
};

const { createCanvas } = require('canvas');

function createBlackImage() {
  const width = 400;
  const height = 400;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer();
}

returnProgressMessage = (batchid) => {
  // Return a formatted discord message tracking progress for a specific batchid
  let err = false;
  try {
    console.log("BatchID ", batchid);
    let r = resultCache.get(batchid);
    let content = '';
    let imageUrl = '';
    if (r) {
      switch (r.status) {
        case 'in_progress':
          content = ':green_circle: In progress';
          break;
        case 'pending':
          content = ':orange_circle: Pending';
          break;
        case 'failed':
          content = ':red_circle: Failed';
          break;
        case 'completed':
          content = ':tada: Completed';
          break;
      }
      content += ' ';
      if (r.hostname) {
        content += ' on `' + r.hostname + '`';
      }
      content += '\n';
      if (['in_progress'].includes(r.status) && r.progress?.step !== undefined) {
        let percent = (parseInt(r.progress?.step) / parseInt(r.progress?.total_steps)) * 100;
        content += emoji(percent / 100) + ' ' + r.progress?.step + ' / ' + r.progress?.total_steps + ' (' + percent.toFixed(0) + '%) ';
      } else if (r.results.length > 0 && r.results[r.results.length - 1].type) {
        content = content + ':floppy_disk: ' + r.results[r.results.length - 1].type + '\n';
      }
      let components = [{
        type: 1,
        components: [{
          type: 2,
          style: 4,
          label: 'Cancel',
          custom_id: 'cancelBatch-' + batchid,
          emoji: {
            name: '🗑️',
            id: null
          },
          disabled: false
        }]
      }];
      if (r.progress?.progress_image_url) {
        debugLog('progress image URL');
        debugLog(r.progress.progress_image_url);
        imageUrl = r.progress.progress_image_url;
      }
      return {
        content: content,
        components: components,
        imageUrl: imageUrl
      };
    } else {
      return null;
    }
  } catch (err) {
    throw (err);
  }
};
emoji = (percent,emojis=null)=>{
    if(percent===undefined||percent>100||percent===NaN) return ''
    emojiLibrary=[
        [':hourglass_flowing_sand:',':hourglass:'],
        ['🥚','🐣','🐤','🐔','🔥','🍗',':yum:'],
        [':clock12:',':clock1:',':clock2:',':clock3:',':clock4:',':clock5:',':clock6:',':clock7:',':clock8:',':clock9:',':clock10:',':clock11:'],
        [':baby:',':girl:',':woman:',':mirror_ball:',':heart_eyes:',':man_beard:',':kiss_woman_man:',':couple:',':ring:',':wedding:',':kiss_woman_man:',':bouquet:',':dove:',':red_car:',':airplane_departure:',':airplane:',':airplane_arriving:',':hotel:',':bed:',':smirk:',':eggplant:',':astonished:',':cherry_blossom:',':heart_on_fire:',':hushed:',':stuck_out_tongue:',':sweat_drops:',':sweat_smile:',':stuck_out_tongue_closed_eyes:',':stuck_out_tongue_winking_eye:',':sleeping:',':sleeping_accommodation:',':thermometer_face:',':nauseated_face:',':face_vomiting:',':pregnant_woman:',':pregnant_person:',':pregnant_man:',':ambulance:',':hospital:',':cold_sweat:',':face_exhaling:',':face_with_symbols_over_mouth:',':relieved:',':family_mwg:']
    ]
    if (!emojis){emojis=emojiLibrary[1]}
    const numEmojis = emojis.length
    const emojiIndex = Math.floor(percent * numEmojis)
    var emoji = emojis[emojiIndex]
    if(!emoji){emoji=emojis[emojis.length-1]}
    return emoji
}

module.exports = {
    progress:{
        update
    }
}
