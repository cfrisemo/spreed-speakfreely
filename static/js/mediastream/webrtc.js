/*
 * Spreed Speak Freely.
 * Copyright (C) 2013-2014 struktur AG
 *
 * This file is part of Spreed Speak Freely.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

// Android detection hack - probably put this someplace else.
var webrtcDetectedAndroid = ((window.navigator||{}).userAgent).match(/android (\d+)/i) !== null;

define([
  'jquery',
  'underscore',
  'mediastream/peercall',
  'mediastream/peerconference',
  'mediastream/peerxfer',
  'mediastream/peerscreenshare',
  'mediastream/usermedia',
  'mediastream/utils',
  'mediastream/tokens',
  'webrtc.adapter',],
  function($, _, PeerCall, PeerConference, PeerXfer, PeerScreenshare, UserMedia, utils, tokens) {

  if (webrtcDetectedAndroid) {
      console.log("This seems to be Android");
  }

  var WebRTC = function(api) {

    this.api = api;

    this.e = $({});

    this.currentcall = null;
    this.currentconference = null;
    this.msgQueue = [];

    this.started = false;
    this.initiator = null;
    this.audioMute = false;
    this.videoMute = false;

    // Settings.are cloned into peer call on call creation.
    this.settings = {
      stereo: false,
      mediaConstraints: {
          audio: true,
          video: {
              optional: [],
              mandatory: {
                  maxWidth: 640,
                  maxHeight: 480
              }
          }
      },
      pcConfig: {
          iceServers: [
              {url: 'stun:'+'stun.l.google.com:19302'}
          ]
      },
      pcConstraints: {
          optional: []
      },
      // Set up audio and video regardless of what devices are present.
      sdpConstraints: {
          mandatory: {
              OfferToReceiveAudio: true,
              OfferToReceiveVideo: true
          }
      },
      offerConstraints: {
          mandatory: {},
          optional: []
      }
    }

    this.api.e.bind("received.offer received.candidate received.answer received.bye received.conference", _.bind(this.processReceived, this));

    window.onbeforeunload = _.bind(function() {
        if (this.currentcall) {
          this.currentcall.close();
          this.api.sendBye(this.currentcall.id);
        }
        if (this.currentconference) {
          this.currentconference.close();
        }
        if (this.api.connector) {
          this.api.connector.disabled = true;
        }
    }, this);

    // Create default media (audio/video).
    this.usermedia = new UserMedia();
    this.usermedia.e.on("mediasuccess mediaerror", _.bind(function() {
      // Start always, no matter what.
      this.maybeStart();
    }, this));

  };

  WebRTC.prototype.processReceived = function(event, to, data, type, to2, from) {

    //console.log(">>>>>>>>>>>>", type, from, data, to, to2);

    if (data && data._token) {
      // Internal token request.
      var token = data._token;
      var id = data._id;
      delete data._token;
      delete data._id;
      // TODO(longsleep): Check if that really needs to be in another file.
      tokens.processReceivedMessage(this, token, id, to, data, type, to2, from);
      return;
    }

    if (!this.initiator && !this.started) {
        switch (type) {
        case "Offer":
            if (this.currentcall) {
                console.warn("Received Offer while not started and with current call -> busy.", from);
                this.api.sendBye(from, "busy");
                this.e.triggerHandler("busy", [from, to2, to]);
                return;
            }
            this.msgQueue.unshift([to, data, type, to2, from]);
            // create call
            this.currentcall = this.createCall(from, from, from);
            // delegate next steps to Ui
            this.e.triggerHandler("offer", [from, to2, to]);
            break;
        case "Bye":
            if (!this.currentcall) {
                console.warn("Received Bye while without currentcall -> ignore.", from);
                return;
            }
            if (this.currentcall.from !== from) {
                console.warn("Received Bye from another id -> ignore.", from);
                return;
            }
            console.log("Bye process (started false)");
            this.doHangup();
            break;
        default:
            this.msgQueue.push([to, data, type, to2, from]);
            break;
        }
    } else {
        this.processReceivedMessage(to, data, type, to2, from);
    }

  };

  WebRTC.prototype.findTargetCall = function(id) {

    var targetcall = null;
    if (this.currentcall) {
      do {
          if (this.initiator && this.currentcall.to === id) {
              targetcall = this.currentcall;
              break;
          }
          if (!this.initiator && this.currentcall.from === id) {
              targetcall = this.currentcall;
              break;
          }
          if (this.currentconference) {
              targetcall = this.currentconference.getCall(id)
          }
      } while(false);
    }
    return targetcall;

  };

  WebRTC.prototype.callForEachCall = function(fn) {

    var count = 0;
    if (this.currentcall) {
      fn(this.currentcall, count);
      count++;
      if (this.currentconference) {
        _.each(this.currentconference.calls, function(v, count) {
          fn(v);
          count++;
        });
      }
    }
    return count;

  };

  WebRTC.prototype.processReceivedMessage = function(to, data, type, to2, from) {

    if (!this.started) {
      console.log('PeerConnection has not been created yet!');
      return;
    }

    switch (type) {
    case "Offer":
        var busy = false;
        var conference = null;
        if (this.currentcall.from !== from) {
            if (this.currentconference && this.currentconference.id === data._conference) {
                console.log("Received conference Offer -> auto.", from, data._conference);
                conference = data._conference;
                // clean own internal data before feeding into browser.
                delete data._conference;
            } else {
                console.log("Received Offer from unknown id -> busy.", from, this.currentconference);
                busy = true;
            }
        }
        if (busy) {
            this.api.sendBye(from, "busy");
            this.e.triggerHandler("busy", [from, to2, to]);
            return;
        }
        console.log("Offer process.");
        if (this.settings.stereo) {
            data.sdp = utils.addStereo(data.sdp);
        }
        if (conference) {
            this.currentconference.autoAnswer(from, new RTCSessionDescription(data));
        } else {
            this.currentcall.setRemoteDescription(new RTCSessionDescription(data), _.bind(this.doAnswer, this));
        }
        break;
    case "Candidate":
        var targetcall = this.findTargetCall(from);
        if (!targetcall) {
            console.warn("Received Candidate for unknown id -> ignore.", from);
            return;
        }
        var candidate = new RTCIceCandidate({sdpMLineIndex: data.sdpMLineIndex, sdpMid: data.sdpMid, candidate: data.candidate});
        targetcall.addIceCandidate(candidate);
        //console.log("Got candidate", data.sdpMid, data.sdpMLineIndex, data.candidate);
        break;
    case "Answer":
        var targetcall = this.findTargetCall(from);
        if (!targetcall) {
            console.warn("Received Answer from unknown id -> ignore", from);
            return;
        }
        console.log("Answer process.");
        if (this.settings.stereo) {
            data.sdp = utils.addStereo(data.sdp);
        }
        // TODO(longsleep): In case of negotiation this could switch offer and answer
        // and result in a offer sdp sent as answer data. We need to handle this.
        targetcall.setRemoteDescription(new RTCSessionDescription(data));
        break;
    case "Bye":
        var targetcall = this.findTargetCall(from);
        if (!targetcall) {
            console.warn("Received Bye from unknown id -> ignore.", from);
            return;
        }
        console.log("Bye process.");
        if (targetcall === this.currentcall) {
            var newcurrentcall;
            if (this.currentconference) {
                // Hand over current call to next conference call.
                newcurrentcall = this.currentconference.handOver();
            }
            if (newcurrentcall) {
                this.currentcall = newcurrentcall;
                targetcall.close()
                this.api.sendBye(targetcall.id, null);
                this.e.triggerHandler("peercall", [newcurrentcall]);
                this.e.triggerHandler("peerconference", [this.currentconference]);
            } else {
                this.doHangup();
                this.e.triggerHandler("bye", [data.Reason, from, to, to2]);
            }
        } else {
            targetcall.close();
            this.api.sendBye(targetcall.id, null);
        }
        break;
    case "Conference":
        if (!this.currentcall || data.indexOf(this.currentcall.id) === -1) {
            console.warn("Received Conference for unknown call -> ignore.", to, data);
            return;
        } else {
            var currentconference = this.currentconference;
            if (!currentconference) {
                currentconference = this.currentconference = new PeerConference(this, this.currentcall, to);
                currentconference.e.one("finished", _.bind(function() {
                    this.currentconference = null;
                    this.e.triggerHandler("peerconference", [null]);
                }, this));
            } else {
                if (currentconference.id !== to) {
                    console.warn("Received Conference for wrong id -> ignore.", to, currentconference);
                    return;
                }
            }
            currentconference.applyUpdate(data);
            this.e.triggerHandler("peerconference", [currentconference]);
        }
        break;
    default:
        console.log("Unhandled message type", type, data);
    }

  };

  WebRTC.prototype.testMediaAccess = function(cb) {

    var success = function(stream) {
        console.info("testMediaAccess success");
        stream.stop();
        cb(true);
    }
    var failed = function() {
        console.info("testMediaAccess failed");
        cb(false);
    }
    UserMedia.testGetUserMedia(success, failed);

  };

  WebRTC.prototype.createCall = function(id, from, to) {

    var currentcall = new PeerCall(this, id, from, to);
    currentcall.e.on("connectionStateChange", _.bind(function(event, iceConnectionState, currentcall) {
      this.onConnectionStateChange(iceConnectionState, currentcall);
    }, this));
    currentcall.e.on("remoteStreamAdded", _.bind(function(event, stream, currentcall) {
      this.onRemoteStreamAdded(stream, currentcall);
    }, this));
    currentcall.e.on("remoteStreamRemoved", _.bind(function(event, stream, currentcall) {
      this.onRemoteStreamRemoved(stream, currentcall);
    }, this));
    currentcall.e.on("error", _.bind(function(event, id, message) {
      if (!id) {
        id = "failed_peerconnection";
      }
      this.e.triggerHandler("error", [message, id]);
      _.defer(_.bind(this.doHangup, this), "error", currentcall.id); // Hangup on error is good yes??
    }, this));

    return currentcall;

  };

  WebRTC.prototype.doCall = function(id) {

    if (this.currentcall) {
        // Conference mode.
        var currentconference = this.currentconference;
        if (!currentconference) {
            currentconference = this.currentconference = new PeerConference(this, this.currentcall);
            currentconference.e.one("finished", _.bind(function() {
                this.currentconference = null;
                this.e.triggerHandler("peerconference", [null]);
            }, this));
        }
        currentconference.doCall(id);
        this.e.triggerHandler("peerconference", [currentconference]);
    } else {
        var currentcall = this.currentcall = this.createCall(id, null, id);
        this.e.triggerHandler("peercall", [currentcall]);
        var ok = this.usermedia.doGetUserMedia(currentcall);
        if (ok) {
          this.e.triggerHandler("waitforusermedia", [currentcall]);
        } else {
          this.e.triggerHandler("error", ["Failed to access camera/microphone.", "failed_getusermedia"]);
          return this.doHangup();
        }
        this.initiator = true;
    }
  };

  WebRTC.prototype.doAccept = function() {

    //NOTE(longsleep): currentcall was created as early as possible to be able to process incoming candidates.
    var currentcall = this.currentcall;
    if (!currentcall) {
      console.warn("Trying to accept without a call.", currentcall);
      return;
    }
    var ok = this.usermedia.doGetUserMedia(currentcall);
    if (ok) {
      this.e.triggerHandler("waitforusermedia", [currentcall]);
    } else {
      this.e.triggerHandler("error", ["Failed to access camera/microphone.", "failed_getusermedia"]);
      return this.doHangup();
    }

  };

  WebRTC.prototype.doAnswer = function() {

    this.e.triggerHandler("peercall", [this.currentcall]);
    this.currentcall.createAnswer(_.bind(function(sessionDescription, currentcall) {
        console.log("Sending answer", sessionDescription, currentcall.id);
        this.api.sendAnswer(currentcall.id, sessionDescription);
    }, this));

  };

  WebRTC.prototype.doXfer = function(id, token, options) {

    var registeredToken = tokens.get(token);
    if (!registeredToken) {
      console.warn("Cannot start xfer for unknown token", token);
      return;
    }

    // Create new xfer object.
    var xfer = new PeerXfer(this, null, token, id);
    var opts = $.extend({
      created: function() {},
      connected: function() {},
      error: function() {},
      closed: function() {}
    }, options);

    // Store as handler on the token object.
    registeredToken.addHandler(xfer, id);

    // Bind ICE connection state events.
    xfer.e.on("connectionStateChange", _.bind(function(event, iceConnectionState, currentxfer) {
      console.log("Xfer state changed", iceConnectionState);
      switch (iceConnectionState) {
      case "connected":
        // Do nothing here, we wait for dataReady.
        break
      case "disconnected":
        opts.error(currentxfer);
        break;
      case "closed":
        opts.closed(currentxfer);
        break;
      }
    }, this));

    // Bind data channel ready event.
    xfer.e.on("dataReady", _.bind(function(event, currentxfer) {
      opts.connected(currentxfer);
    }, this));

    // Trigger initial event.
    opts.created(xfer);

    // Connect.
    xfer.setInitiate(true);
    xfer.createPeerConnection();
    xfer.createOffer(_.bind(function(sessionDescription, currentxfer) {
        console.log("Sending xfer offer with sessionDescription", sessionDescription, currentxfer.id);
        // TODO(longsleep): Support sending this through data channel too if we have one.
        this.api.sendOffer(id, sessionDescription);
    }, this));

  };

  WebRTC.prototype.doScreenshare = function(options) {

    var usermedia = new UserMedia({noaudio: true});
    var ok = usermedia.doGetUserMedia(null, PeerScreenshare.getMediaContraints());
    if (ok) {
      this.e.one("done", function() {
        usermedia.stop();
      });
      return usermedia;
    } else {
      return null;
    }

  };

  WebRTC.prototype.doSubscribeScreenshare = function(id, token, options) {

    var registeredToken = tokens.get(token);
    if (!registeredToken) {
      console.warn("Cannot subscribe screen share for unknown token", token);
      return;
    }

    var peerscreenshare = new PeerScreenshare(this, null, token, id);
    var opts = $.extend({
      created: function() {},
      connected: function() {},
      error: function() {},
      closed: function() {}
    }, options);

    this.e.one("done", function() {
      peerscreenshare.close();
    });

    // Store as handler on the token object.
    registeredToken.addHandler(peerscreenshare, id);

    // Bind ICE connection state events.
    peerscreenshare.e.on("connectionStateChange", _.bind(function(event, iceConnectionState, currentscreenshare) {
      console.log("Screen share state changed", iceConnectionState);
      switch (iceConnectionState) {
      case "connected":
        opts.connected(currentscreenshare);
        break
      case "disconnected":
        opts.error(currentscreenshare);
        break;
      case "closed":
        opts.closed(currentscreenshare);
        break;
      }
    }, this));

    // Trigger initial event.
    opts.created(peerscreenshare);

    // Connect.
    peerscreenshare.setInitiate(true); //XXX(longsleep): This creates a data channel which is not needed.
    peerscreenshare.createPeerConnection();
    peerscreenshare.createOffer(_.bind(function(sessionDescription, currentscreenshare) {
        console.log("Sending screen share offer with sessionDescription", sessionDescription, currentscreenshare.id);
        // TODO(longsleep): Support sending this through data channel too if we have one.
        this.api.sendOffer(id, sessionDescription);
    }, this));

  };

  WebRTC.prototype.stop = function() {

    if (this.currentconference) {
        this.currentconference.close();
        this.currentconference = null;
    }
    if (this.currentcall) {
        this.currentcall.close();
        this.currentcall = null;
    }
    if (this.usermedia) {
        this.usermedia.stop();
    }
    this.e.triggerHandler("peerconference", [null]);
    this.e.triggerHandler("peercall", [null]);
    this.msgQueue.length = 0;
    this.initiator = null;
    this.started = false;

  }

  WebRTC.prototype.doHangup = function(reason, id) {

    console.log("Hanging up.", id);
    if (id) {
        var currentcall = this.findTargetCall(id);
        if (!currentcall) {
            console.warn("Tried to hangup unknown call.", reason, id);
            return;
        }
        if (currentcall !== this.currentcall) {
            currentcall.close();
            this.api.sendBye(id, reason);
            if (this.currentcall && currentcall) {
                this.e.triggerHandler("statechange", ["connected", this.currentcall]);
            } else {
                this.e.triggerHandler("done", [reason]);
            }
            return;
        }
    }
    if (this.currentcall) {
        id = this.currentcall.id;
        this.e.triggerHandler("done", [reason]);
    }
    this.stop();
    if (id) {
        this.api.sendBye(id, reason);
    }

  }

  WebRTC.prototype.maybeStart = function() {

    //console.log("maybeStart", this.started);
    if (!this.started) {

        var currentcall = this.currentcall;
        currentcall.setInitiate(this.initiator);
        this.e.triggerHandler("connecting", [currentcall]);
        console.log('Creating PeerConnection.', currentcall);
        currentcall.createPeerConnection(_.bind(function(peerconnection) {
          // Success call.
          if (this.usermedia) {
                this.usermedia.applyVideoMute(this.videoMute);
                this.usermedia.applyAudioMute(this.audioMute);
                this.e.triggerHandler("usermedia", [this.usermedia]);
                this.usermedia.addToPeerConnection(peerconnection);
            }
            this.started = true;
            if (this.initiator) {
                currentcall.createOffer(_.bind(function(sessionDescription, currentcall) {
                    console.log("Sending offer with sessionDescription", sessionDescription, currentcall.id);
                    this.api.sendOffer(currentcall.id, sessionDescription);
                }, this));
            } else {
                this.calleeStart();
            }
        }, this), _.bind(function() {
          // Error call.
          this.e.triggerHandler("error", ["Failed to create peer connection. See log for details."]);
          this.doHangup();
        }, this));

    }

  };

  WebRTC.prototype.calleeStart = function() {

    var args;
    while (this.msgQueue.length > 0) {
        args = this.msgQueue.shift();
        this.processReceivedMessage.apply(this, args);
    }

  };

  WebRTC.prototype.onConnectionStateChange = function(iceConnectionState, currentcall) {
    this.e.triggerHandler('statechange', [iceConnectionState, currentcall]);
  };

  WebRTC.prototype.onRemoteStreamAdded = function(stream, currentcall) {
    this.e.triggerHandler("streamadded", [stream, currentcall]);
  };

  WebRTC.prototype.onRemoteStreamRemoved = function(stream, currentcall) {
    this.e.triggerHandler("streamremoved", [stream, currentcall]);
  };

  WebRTC.prototype.setVideoMute = function(mute) {

    // Force boolean.
    this.videoMute = !!mute;
    if (this.usermedia) {
        this.usermedia.applyVideoMute(this.videoMute);
    }

  };

  WebRTC.prototype.setAudioMute = function(mute) {

    // Force boolean.
    this.audioMute = !!mute;
    if (this.usermedia) {
        this.usermedia.applyAudioMute(this.audioMute);
    }

  };

  return WebRTC;

});
