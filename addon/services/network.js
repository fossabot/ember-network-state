import { computed, getWithDefault, observer } from '@ember/object';
import Evented from '@ember/object/evented';
import Service from '@ember/service';
import { STATES, CONFIG } from '../constants';
import fetch, { AbortController } from 'fetch';
import { cancel, later } from '@ember/runloop';
import { getOwner } from '@ember/application';
import {
	equal,
	notEmpty,
	reads
} from '@ember/object/computed';
import { A } from '@ember/array';

export default Service.extend(Evented, {

	/**
	 * State property. Posible values:
	 *
	 *  * ONLINE
	 *  * OFFLINE
	 *  * LIMITED
	 *
	 * @property state
	 * @type {String}
	 */
	state: reads('_state').readOnly(),

	/**
	 * Check when network is online.
	 *
	 * @property isOnline
	 * @type {Boolean}
	 */
	isOnline: equal('_state', STATES.ONLINE),

	/**
	 * Check when network is offline.
	 *
	 * @property isOffline
	 * @type {Boolean}
	 */
	isOffline: equal('_state', STATES.OFFLINE),

	/**
	 * Check when network is limited.
	 *
	 * @property isLimited
	 * @type {Boolean}
	 */
	isLimited: equal('_state', STATES.LIMITED),

	/**
	 * Check when network is reconnecting.
	 *
	 * @property isReconnecting
	 * @type {Boolean}
	 */
	isReconnecting: notEmpty('_controllers'),

	/**
	 * Check when timer is enabled.
	 *
	 * @property hasTimer
	 * @type {Boolean}
	 */
	hasTimer: notEmpty('_timer'),

	/**
	 * Remaining time for next reconnect.
	 *
	 * @property remaining
	 * @type {Number}
	 */
	remaining: computed(function() {
		const timestamp = this.get('_timestamp');

		if (!timestamp) {
			return NaN;
		}

		const delta = timestamp - Date.now();

		return delta > 0 ? delta : 0;
	}).volatile(),

	/**
	 * Last reconnect duration.
	 *
	 * @property lastReconnectDuration
	 * @type {Number}
	 */
	lastReconnectDuration: 0,

	/**
	 * Last reconnect status.
	 *
	 * @property lastReconnectStatus
	 * @type {Number}
	 */
	lastReconnectStatus: 0,

	/**
	 * Init window listeners.
	 *
	 * @method init
	 */
	init() {
		this._super(...arguments);

		const connection = this.get('_connection');
		const appConfig = getOwner(this).resolveRegistration('config:environment');
		const addonConfig = getWithDefault(appConfig, 'network-state', {});
		const reconnect = Object.assign({}, CONFIG.reconnect, addonConfig.reconnect);

		this.set('_controllers', A());
		this.set('_config', { reconnect });

		const changeNetworkBinding = this.get('_changeNetworkBinding');

		window.addEventListener('online', changeNetworkBinding);
		window.addEventListener('offline', changeNetworkBinding);

		if (connection) {
			connection.addEventListener('change', changeNetworkBinding);
		}

		const onLine = window.navigator.onLine;

		this.set('_state', onLine ? STATES.ONLINE : STATES.OFFLINE);

		if (onLine) {
			this.reconnect();
		}
	},

	/**
	 * Force reconnection.
	 *
	 * @method reconnect
	 */
	reconnect() {
		this._clearTimer();
		this._reconnect();
	},

	/**
	 * Deinit window listeners.
	 *
	 * @method willDestroy
	 */
	willDestroy() {
		this._super(...arguments);

		const connection = this.get('_connection');
		const changeNetworkBinding = this.get('_changeNetworkBinding');

		window.removeEventListener('online', changeNetworkBinding);
		window.removeEventListener('offline', changeNetworkBinding);

		if (connection) {
			connection.removeEventListener('change', changeNetworkBinding);
		}
	},

	/**
	 * Access to connection API.
	 *
	 * @property _connection
	 * @type {Object}
	 */
	_connection: computed(() =>
		window.navigator.connection || window.navigator.mozConnection || window.navigator.webkitConnection
	),

	/**
	 * State property. Posible values:
	 *
	 *  * ONLINE
	 *  * OFFLINE
	 *  * LIMITED
	 *
	 * @property _state
	 * @type {String}
	 * @private
	 */
	_state: null,

	/**
	 * Handles network change.
	 *
	 * @method _onChange
	 * @private
	 */
	_onChange: observer('_state', function() {
		const state = this.get('_state');

		this._clearTimer();

		this.trigger('change', state);
	}),

	/**
	 * Clear timer for reconnect.
	 *
	 * @method _clearTimer
	 */
	_clearTimer() {
		const timer = this.get('_timer');

		if (timer) {
			cancel(timer);

			this.set('_timer');
		}

		this.set('_nextDelay');
		this.set('_times', 0);
		this.set('_timestamp');
	},

	/**
	 * Saved timer.
	 *
	 * @property _timer
	 * @type {Number}
	 */
	_timer: null,

	/**
	 * Retry times.
	 *
	 * @property _times
	 * @type {Number}
	 */
	_times: 0,

	/**
	 * Change network binding.
	 *
	 * @property changeNetworkBinding
	 * @type Function
	 * @private
	 */
	_changeNetworkBinding: computed(function() {
		return this._changeNetwork.bind(this);
	}),

	/**
	 * React to network changes.
	 *
	 * @method _changeNetwork
	 * @private
	 */
	_changeNetwork() {
		const onLine = window.navigator.onLine;

		if (!onLine) {
			this.set('_state', STATES.OFFLINE);
		} else {
			this.reconnect();
		}
	},

	/**
	 * Check connection.
	 *
	 * @method _reconnect
	 * @private
	 */
	async _reconnect() {
		const { reconnect } = this.get('_config');
		const controller = new AbortController();

		// Cancel all ongoing controllers.
		this._abortControllers();
		// Push new controller.
		this.get('_controllers').pushObject(controller);

		const timeout = later(controller, 'abort', reconnect.timeout);
		const start = performance.now();
		let status = 0;

		try {
			const response = await fetch(reconnect.path, {
				method: 'HEAD',
				cache: 'no-store',
				signal: controller.signal,
				headers: { 'cache-control': 'no-cache' }
			});

			this.get('_controllers').removeObject(controller);

			status = response.status;

			this.set('_state', STATES.ONLINE);
		} catch (e) {
			this.get('_controllers').removeObject(controller);

			if (!this.get('isReconnecting')) {
				this._handleError();
			}
		} finally {
			cancel(timeout);

			if (this.isDestroyed) {
				return;
			}

			if (!this.get('isReconnecting')) {
				this.setProperties({
					lastReconnectStatus: status,
					lastReconnectDuration: performance.now() - start
				});
			}
		}
	},

	/**
	 * List of fetch abort controllers.
	 *
	 * @property _controllers
	 * @type {Array}
	 */
	_controllers: null,

	/**
	 * Abort all controllers.
	 *
	 * @method _abortControllers
	 */
	_abortControllers() {
		const controllers = this.get('_controllers');

		controllers.forEach((controller) => {
			controller.abort();
		});

		controllers.clear();
	},

	/**
	 * Handle error from fetch.
	 *
	 * @method _handleError
	 * @param {Error} e
	 * @private
	 */
	_handleError() {
		const { reconnect } = this.get('_config');
		const onLine = window.navigator.onLine;

		if (onLine) {
			this.set('_state', STATES.LIMITED);

			if (reconnect.auto) {
				this.incrementProperty('_times');
				this._delayReconnect();
			}
		} else {
			this.set('_state', STATES.OFFLINE);
		}
	},

	/**
	 * Schedule next reconnect.
	 *
	 * @method _delayReconnect
	 * @private
	 */
	_delayReconnect() {
		const { reconnect } = this.get('_config');
		const delay = this.getWithDefault('_nextDelay', reconnect.delay);
		const times = this.get('_times');
		let nextDelay = delay * reconnect.multiplier;

		if (reconnect.maxTimes > -1 && times >= reconnect.maxTimes) {
			this._clearTimer();
			this.set('_state', STATES.LIMITED);
			return;
		}

		if (nextDelay > reconnect.maxDelay) {
			nextDelay = reconnect.maxDelay;
		}

		const timer = later(this, '_reconnect', delay);

		this.setProperties({
			_nextDelay: nextDelay,
			_timestamp: Date.now() + delay,
			_timer: timer
		});
	}

});
