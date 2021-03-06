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
define(['jquery', 'text!partials/socialshare.html'], function($, template) {

	var urls = {
		email: "mailto:?subject=_TEXT_%20_URL_",
		facebook: "https://www.facebook.com/sharer.php?u=_URL_&t=_TEXT_",
		twitter: "https://twitter.com/share?url=_URL_&text=_TEXT_&via=_SITE_",
		google: "https://plus.google.com/share?url=_URL_",
		xing: "https://www.xing.com/app/user?op=share;url=_URL_"
	};

	// socialShare
	return ["$window", "translation", function($window, translation) {

		var title = $window.encodeURIComponent($window.document.title);
		var makeUrl = function(nw, target) {
			var url = urls[nw];
			if (url) {
				url = url.replace(/_URL_/, $window.encodeURIComponent(target)).replace(/_TEXT_/, $window.encodeURIComponent(translation._("Meet with me here:"))).replace(/_SITE_/, title);
			}
			return url;
		};

		return {
			scope: true,
			restrict: "E",
			template: template,
			replace: true,
			link: function($scope, $element, $attr) {
				$element.on("click", "a", function(event) {
					var nw = $(event.currentTarget).data("nw");
					var url = makeUrl(nw, $scope.roomlink);
					if (url) {
						if (nw==="email") {
							// Hack our way to disable unload popup for mail links.
							$scope.manualReloadApp(url);
						} else {
							$window.open(url, "social_"+nw, "menubar=no,toolbar=no,resizable=yes,width=600,height=600,scrollbars=yes");
						}
					}
				});
			}
		}

	}];

});