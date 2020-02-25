/**
 * app.js : User Interface implementation
 * This file handles the interaction between the application and the user
 * 
 * Copyright 2013-2014 Mossroy and contributors
 * License GPL v3:
 * 
 * This file is part of Kiwix.
 * 
 * Kiwix is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * Kiwix is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with Kiwix (file LICENSE-GPLv3.txt).  If not, see <http://www.gnu.org/licenses/>
 */

'use strict';

// This uses require.js to structure javascript:
// http://requirejs.org/docs/api.html#define

define(['jquery', 'zimArchiveLoader', 'util', 'uiUtil', 'cookies','abstractFilesystemAccess','q'],
 function($, zimArchiveLoader, util, uiUtil, cookies, abstractFilesystemAccess, q) {
     
    /**
     * Maximum number of articles to display in a search
     * @type Integer
     */
    var MAX_SEARCH_RESULT_SIZE = 50;

    /**
     * The delay (in milliseconds) between two "keepalive" messages
     * sent to the ServiceWorker (so that it is not stopped by
     * the browser, and keeps the MessageChannel to communicate
     * with the application)
     * @type Integer
     */
    var DELAY_BETWEEN_KEEPALIVE_SERVICEWORKER = 30000;

    /**
     * The name of the Cache API cache to use for caching Service Worker requests and responses for certain asset types
     * This name will be passed to service-worker.js in messaging to avoid duplication: see comment in service-worker.js
     * We need access to this constant in app.js in order to complete utility actions when Service Worker is not initialized 
     * @type {String}
     */
    var CACHE_NAME = 'kiwixjs-assetCache';
    
    /**
     * Memory cache for CSS styles contained in ZIM: it significantly speeds up subsequent page display
     * This cache is used by default in jQuery mode, but can be turned off in Configuration for low-memory devices
     * In Service Worker mode, the Cache API will be used instead
     * @type {Map}
     */
    var cssCache = new Map();

    /**
     * @type ZIMArchive
     */
    var selectedArchive = null;
    
    // Set parameters and associated UI elements from cookie
    // DEV: The params global object is declared in init.js so that it is available to modules
    params['hideActiveContentWarning'] = cookies.getItem('hideActiveContentWarning') === 'true';
    params['showUIAnimations'] = cookies.getItem('showUIAnimations') ? cookies.getItem('showUIAnimations') === 'true' : true;
    document.getElementById('hideActiveContentWarningCheck').checked = params.hideActiveContentWarning;
    document.getElementById('showUIAnimationsCheck').checked = params.showUIAnimations;
    // A global parameter that turns caching on or off and deletes the cache (it defaults to true unless explicitly turned off in UI)
    params['useCache'] = cookies.getItem('useCache') !== 'false';
    // A parameter to set the app theme and, if necessary, the CSS theme for article content (defaults to 'light')
    params['appTheme'] = cookies.getItem('appTheme') || 'light'; // Currently implemented: light|dark|dark_invert|dark_mwInvert
    document.getElementById('appThemeSelect').value = params.appTheme;
    uiUtil.applyAppTheme(params.appTheme);

    // Define globalDropZone (universal drop area) and configDropZone (highlighting area on Config page)
    var globalDropZone = document.getElementById('search-article');
    var configDropZone = document.getElementById('configuration');
    
    // Unique state to identify  latest asyn action that can result in false diaplyed.
    // actionIdentifier can be either the key/url for searching or the url of expected article to be displayed.
    var latestUserAsynAction = {"action": "", "actionIdentifier": ""};
    
    /**
     * Resize the IFrame height, so that it fills the whole available height in the window
     */
    function resizeIFrame() {
        var height = $(window).outerHeight()
                - $("#top").outerHeight(true)
                // TODO : this 5 should be dynamically computed, and not hard-coded
                - 5;
        $(".articleIFrame").css("height", height + "px");
    }
    $(document).ready(resizeIFrame);
    $(window).resize(resizeIFrame);
    
    // Define behavior of HTML elements
    var searchArticlesFocused = false;
    $('#searchArticles').on('click', function() {
        $("#welcomeText").hide();
        $('.alert').hide();
        $("#searchingArticles").show();
        pushBrowserHistoryState(null, $('#prefix').val());
        searchDirEntriesFromPrefix($('#prefix').val());
        $('.navbar-collapse').collapse('hide');
        document.getElementById('prefix').focus();
        // This flag is set to true in the mousedown event below
        searchArticlesFocused = false;
    });
    $('#searchArticles').on('mousedown', function() {
        // We set the flag so that the blur event of #prefix can know that the searchArticles button has been clicked
        searchArticlesFocused = true;
    });
    $('#formArticleSearch').on('submit', function() {
        document.getElementById('searchArticles').click();
        return false;
    });
    // Handle keyboard events in the prefix (article search) field
    var keyPressHandled = false;
    $('#prefix').on('keydown', function(e) {
        // If user presses Escape...
        // IE11 returns "Esc" and the other browsers "Escape"; regex below matches both
        if (/^Esc/.test(e.key)) {
            // Hide the article list
            e.preventDefault();
            e.stopPropagation();
            $('#articleListWithHeader').hide();
            $('#articleContent').focus();
            keyPressHandled = true;
        }
        // Arrow-key selection code adapted from https://stackoverflow.com/a/14747926/9727685
        // IE11 produces "Down" instead of "ArrowDown" and "Up" instead of "ArrowUp"
        if (/^((Arrow)?Down|(Arrow)?Up|Enter)$/.test(e.key)) {
            // User pressed Down arrow or Up arrow or Enter
            e.preventDefault();
            e.stopPropagation();
            // This is needed to prevent processing in the keyup event : https://stackoverflow.com/questions/9951274
            keyPressHandled = true;
            var activeElement = document.querySelector("#articleList .hover") || document.querySelector("#articleList a");
            if (!activeElement) return;
            // If user presses Enter, read the dirEntry
            if (/Enter/.test(e.key)) {
                if (activeElement.classList.contains('hover')) {
                    var dirEntryId = activeElement.getAttribute('dirEntryId');
                    findDirEntryFromDirEntryIdAndLaunchArticleRead(dirEntryId);
                    return;
                }
            }
            // If user presses ArrowDown...
            // (NB selection is limited to five possibilities by regex above)
            if (/Down/.test(e.key)) {
                if (activeElement.classList.contains('hover')) {
                    activeElement.classList.remove('hover');
                    activeElement = activeElement.nextElementSibling || activeElement;
                    var nextElement = activeElement.nextElementSibling || activeElement;
                    if (!uiUtil.isElementInView(nextElement, true)) nextElement.scrollIntoView(false);
                }
            }
            // If user presses ArrowUp...
            if (/Up/.test(e.key)) {
                activeElement.classList.remove('hover');
                activeElement = activeElement.previousElementSibling || activeElement;
                var previousElement = activeElement.previousElementSibling || activeElement;
                if (!uiUtil.isElementInView(previousElement, true)) previousElement.scrollIntoView();
                if (previousElement === activeElement) document.getElementById('top').scrollIntoView();
            }
            activeElement.classList.add('hover');
        }
    });
    // Search for titles as user types characters
    $('#prefix').on('keyup', function(e) {
        if (selectedArchive !== null && selectedArchive.isReady()) {
            // Prevent processing by keyup event if we already handled the keypress in keydown event
            if (keyPressHandled)
                keyPressHandled = false;
            else
                onKeyUpPrefix(e);
        }
    });
    // Restore the search results if user goes back into prefix field
    $('#prefix').on('focus', function(e) {
        if ($('#prefix').val() !== '') 
            $('#articleListWithHeader').show();
    });
    // Hide the search results if user moves out of prefix field
    $('#prefix').on('blur', function() {
        if (!searchArticlesFocused) $('#articleListWithHeader').hide();
    });
    $("#btnRandomArticle").on("click", function(e) {
        $('#prefix').val("");
        goToRandomArticle();
        $("#welcomeText").hide();
        $('#articleListWithHeader').hide();
        $('.navbar-collapse').collapse('hide');
    });
    
    $('#btnRescanDeviceStorage').on("click", function(e) {
        searchForArchivesInStorage();
    });
    // Bottom bar :
    $('#btnBack').on('click', function(e) {
        history.back();
        return false;
    });
    $('#btnForward').on('click', function(e) {
        history.forward();
        return false;
    });
    $('#btnHomeBottom').on('click', function(e) {
        $('#btnHome').click();
        return false;
    });
    $('#btnTop').on('click', function(e) {
        $("#articleContent").contents().scrollTop(0);
        // We return true, so that the link to #top is still triggered (useful in the About section)
        return true;
    });
    // Top menu :
    $('#btnHome').on('click', function(e) {
        // Highlight the selected section in the navbar
        $('#liHomeNav').attr("class","active");
        $('#liConfigureNav').attr("class","");
        $('#liAboutNav').attr("class","");
        $('.navbar-collapse').collapse('hide');
        // Show the selected content in the page
        uiUtil.removeAnimationClasses();
        if (params.showUIAnimations) { 
           uiUtil.applyAnimationToSection("home");
        } else {
            $('#articleContent').show();
            $('#about').hide();
            $('#configuration').hide();
        }
        $('#navigationButtons').show();
        $('#formArticleSearch').show();
        $("#welcomeText").show();
        // Give the focus to the search field, and clean up the page contents
        $("#prefix").val("");
        $('#prefix').focus();
        $("#articleList").empty();
        $('#articleListHeaderMessage').empty();
        $("#searchingArticles").hide();
        $("#articleContent").hide();
        $("#articleContent").contents().empty();
        if (selectedArchive !== null && selectedArchive.isReady()) {
            $("#welcomeText").hide();
            goToMainArticle();
        }
        return false;
    });
    $('#btnConfigure').on('click', function(e) {
        // Highlight the selected section in the navbar
        $('#liHomeNav').attr("class","");
        $('#liConfigureNav').attr("class","active");
        $('#liAboutNav').attr("class","");
        $('.navbar-collapse').collapse('hide');
        // Show the selected content in the page
        uiUtil.removeAnimationClasses();
        if (params.showUIAnimations) { 
            uiUtil.applyAnimationToSection("config");
        } else {
            $('#about').hide();
            $('#configuration').show();
            $('#articleContent').hide();
        }    
        $('#navigationButtons').hide();
        $('#formArticleSearch').hide();
        $("#welcomeText").hide();
        $("#searchingArticles").hide();
        $('.alert').hide();
        refreshAPIStatus();
        refreshCacheStatus();
        return false;
    });
    $('#btnAbout').on('click', function(e) {
        // Highlight the selected section in the navbar
        $('#liHomeNav').attr("class","");
        $('#liConfigureNav').attr("class","");
        $('#liAboutNav').attr("class","active");
        $('.navbar-collapse').collapse('hide');
        // Show the selected content in the page
        uiUtil.removeAnimationClasses();
        if (params.showUIAnimations) { 
            uiUtil.applyAnimationToSection("about");
        } else {
            $('#about').show();
            $('#configuration').hide();
            $('#articleContent').hide();
        }
        $('#navigationButtons').hide();
        $('#formArticleSearch').hide();
        $("#welcomeText").hide();
        $('#articleListWithHeader').hide();
        $("#searchingArticles").hide();
        $('.alert').hide();
        return false;
    });
    $('input:radio[name=contentInjectionMode]').on('change', function(e) {
        // Do the necessary to enable or disable the Service Worker
        setContentInjectionMode(this.value);
    });
    $('input:checkbox[name=hideActiveContentWarning]').on('change', function (e) {
        params.hideActiveContentWarning = this.checked ? true : false;
        cookies.setItem('hideActiveContentWarning', params.hideActiveContentWarning, Infinity);
    });
    $('input:checkbox[name=showUIAnimations]').on('change', function (e) {
        params.showUIAnimations = this.checked ? true : false;
        cookies.setItem('showUIAnimations', params.showUIAnimations, Infinity);
    });
    document.getElementById('appThemeSelect').addEventListener('change', function (e) {
        params.appTheme = e.target.value;
        cookies.setItem('appTheme', params.appTheme, Infinity);
        uiUtil.applyAppTheme(params.appTheme);
    });
    document.getElementById('cachedAssetsModeRadioTrue').addEventListener('change', function (e) {
        if (e.target.checked) {
            cookies.setItem('useCache', true, Infinity);
            params.useCache = true;
            refreshCacheStatus();
        }
    });
    document.getElementById('cachedAssetsModeRadioFalse').addEventListener('change', function (e) {
        if (e.target.checked) {
            cookies.setItem('useCache', false, Infinity);
            params.useCache = false;
            // Delete all caches
            resetCssCache();
            if ('caches' in window) caches.delete(CACHE_NAME);
            refreshCacheStatus();
        }
    });

    /**
     * Displays or refreshes the API status shown to the user
     */
    function refreshAPIStatus() {
        var apiStatusPanel = document.getElementById('apiStatusDiv');
        apiStatusPanel.classList.remove('card-success', 'card-warning');
        var apiPanelClass = 'card-success';
        if (isMessageChannelAvailable()) {
            $('#messageChannelStatus').html("MessageChannel API available");
            $('#messageChannelStatus').removeClass("apiAvailable apiUnavailable")
                    .addClass("apiAvailable");
        } else {
            apiPanelClass = 'card-warning';
            $('#messageChannelStatus').html("MessageChannel API unavailable");
            $('#messageChannelStatus').removeClass("apiAvailable apiUnavailable")
                    .addClass("apiUnavailable");
        }
        if (isServiceWorkerAvailable()) {
            if (isServiceWorkerReady()) {
                $('#serviceWorkerStatus').html("ServiceWorker API available, and registered");
                $('#serviceWorkerStatus').removeClass("apiAvailable apiUnavailable")
                        .addClass("apiAvailable");
            } else {
                apiPanelClass = 'card-warning';
                $('#serviceWorkerStatus').html("ServiceWorker API available, but not registered");
                $('#serviceWorkerStatus').removeClass("apiAvailable apiUnavailable")
                        .addClass("apiUnavailable");
            }
        } else {
            apiPanelClass = 'card-warning';
            $('#serviceWorkerStatus').html("ServiceWorker API unavailable");
            $('#serviceWorkerStatus').removeClass("apiAvailable apiUnavailable")
                    .addClass("apiUnavailable");
        }
        apiStatusPanel.classList.add(apiPanelClass);

    }

    /**
     * Queries Service Worker if possible to determine cache capability and returns an object with cache attributes
     * If Service Worker is not available, the attributes of the memory cache are returned instead
     * @returns {Promise<Object>} A Promise for an object with cache attributes 'type', 'description', and 'count'
     */
    function getCacheAttributes() {
        return q.Promise(function (resolve, reject) {
            if (contentInjectionMode === 'serviceworker') {
                // Create a Message Channel
                var channel = new MessageChannel();
                // Handler for recieving message reply from service worker
                channel.port1.onmessage = function (event) {
                    var cache = event.data;
                    if (cache.error) reject(cache.error);
                    else resolve(cache);
                };
                // Ask Service Worker for its cache status and asset count
                navigator.serviceWorker.controller.postMessage({
                    'action': {
                        'useCache': params.useCache ? 'on' : 'off',
                        'checkCache': window.location.href
                    },
                    'cacheName': CACHE_NAME
                }, [channel.port2]);
            } else {
                // No Service Worker has been established, so we resolve the Promise with cssCache details only
                resolve({
                    'type': params.useCache ? 'memory' : 'none',
                    'description': params.useCache ? 'Memory' : 'None',
                    'count': cssCache.size
                });
            }
        });
    }

    /** 
     * Refreshes the UI (Configuration) with the cache attributes obtained from getCacheAttributes()
     */
    function refreshCacheStatus() {
        // Update radio buttons and checkbox
        document.getElementById('cachedAssetsModeRadio' + (params.useCache ? 'True' : 'False')).checked = true;
        // Get cache attributes, then update the UI with the obtained data
        getCacheAttributes().then(function (cache) {
            document.getElementById('cacheUsed').innerHTML = cache.description;
            document.getElementById('assetsCount').innerHTML = cache.count;
            var cacheSettings = document.getElementById('cacheSettingsDiv');
            var cacheStatusPanel = document.getElementById('cacheStatusPanel');
            [cacheSettings, cacheStatusPanel].forEach(function (card) {
                // IE11 cannot remove more than one class from a list at a time
                card.classList.remove('card-success');
                card.classList.remove('card-warning');
                if (params.useCache) card.classList.add('card-success');
                else card.classList.add('card-warning');
            });
        });
    }

    var contentInjectionMode;
    var keepAliveServiceWorkerHandle;
    
    /**
     * Send an 'init' message to the ServiceWorker with a new MessageChannel
     * to initialize it, or to keep it alive.
     * This MessageChannel allows a 2-way communication between the ServiceWorker
     * and the application
     */
    function initOrKeepAliveServiceWorker() {
        if (contentInjectionMode === 'serviceworker') {
            // Create a new messageChannel
            var tmpMessageChannel = new MessageChannel();
            tmpMessageChannel.port1.onmessage = handleMessageChannelMessage;
            // Send the init message to the ServiceWorker, with this MessageChannel as a parameter
            navigator.serviceWorker.controller.postMessage({'action': 'init'}, [tmpMessageChannel.port2]);
            messageChannel = tmpMessageChannel;
            // Schedule to do it again regularly to keep the 2-way communication alive.
            // See https://github.com/kiwix/kiwix-js/issues/145 to understand why
            clearTimeout(keepAliveServiceWorkerHandle);
            keepAliveServiceWorkerHandle = setTimeout(initOrKeepAliveServiceWorker, DELAY_BETWEEN_KEEPALIVE_SERVICEWORKER, false);
        }
    }
    
    /**
     * Sets the given injection mode.
     * This involves registering (or re-enabling) the Service Worker if necessary
     * It also refreshes the API status for the user afterwards.
     * 
     * @param {String} value The chosen content injection mode : 'jquery' or 'serviceworker'
     */
    function setContentInjectionMode(value) {
        if (value === 'jquery') {
            if (isServiceWorkerReady()) {
                // We need to disable the ServiceWorker
                // Unregistering it does not seem to work as expected : the ServiceWorker
                // is indeed unregistered but still active...
                // So we have to disable it manually (even if it's still registered and active)
                navigator.serviceWorker.controller.postMessage({'action': 'disable'});
                messageChannel = null;
            }
            refreshAPIStatus();
            // User has switched to jQuery mode, so no longer needs CACHE_NAME
            // We should empty it to prevent unnecessary space usage
            if ('caches' in window) caches.delete(CACHE_NAME);
        } else if (value === 'serviceworker') {
            if (!isServiceWorkerAvailable()) {
                alert("The ServiceWorker API is not available on your device. Falling back to JQuery mode");
                setContentInjectionMode('jquery');
                return;
            }
            if (!isMessageChannelAvailable()) {
                alert("The MessageChannel API is not available on your device. Falling back to JQuery mode");
                setContentInjectionMode('jquery');
                return;
            }
            
            if (!isServiceWorkerReady()) {
                $('#serviceWorkerStatus').html("ServiceWorker API available : trying to register it...");
                navigator.serviceWorker.register('../service-worker.js').then(function (reg) {
                    // The ServiceWorker is registered
                    serviceWorkerRegistration = reg;
                    refreshAPIStatus();
                    
                    // We need to wait for the ServiceWorker to be activated
                    // before sending the first init message
                    var serviceWorker = reg.installing || reg.waiting || reg.active;
                    serviceWorker.addEventListener('statechange', function(statechangeevent) {
                        if (statechangeevent.target.state === 'activated') {
                            // Remove any jQuery hooks from a previous jQuery session
                            $('#articleContent').contents().remove();
                            // Create the MessageChannel
                            // and send the 'init' message to the ServiceWorker
                            initOrKeepAliveServiceWorker();
                            // We need to refresh cache status here on first activation because SW was inaccessible till now
                            // We also initialize the CACHE_NAME constant in SW here
                            refreshCacheStatus();
                        }
                    });
                    if (serviceWorker.state === 'activated') {
                        // Even if the ServiceWorker is already activated,
                        // We need to re-create the MessageChannel
                        // and send the 'init' message to the ServiceWorker
                        // in case it has been stopped and lost its context
                        initOrKeepAliveServiceWorker();
                    }
                }, function (err) {
                    console.error('error while registering serviceWorker', err);
                    refreshAPIStatus();
                    var message = "The ServiceWorker could not be properly registered. Switching back to jQuery mode. Error message : " + err;
                    var protocol = window.location.protocol;
                    if (protocol === 'moz-extension:') {
                        message += "\n\nYou seem to be using kiwix-js through a Firefox extension : ServiceWorkers are disabled by Mozilla in extensions.";
                        message += "\nPlease vote for https://bugzilla.mozilla.org/show_bug.cgi?id=1344561 so that some future Firefox versions support it";
                    }
                    else if (protocol === 'file:') {
                        message += "\n\nYou seem to be opening kiwix-js with the file:// protocol. You should open it through a web server : either through a local one (http://localhost/...) or through a remote one (but you need SSL : https://webserver/...)";
                    }
                    alert(message);                        
                    setContentInjectionMode("jquery");
                    return;
                });
            } else {
                // We need to set this variable earlier else the ServiceWorker does not get reactivated
                contentInjectionMode = value;
                initOrKeepAliveServiceWorker();
            }
            // User has switched to Service Worker mode, so no longer needs the memory cache
            // We should empty it to ensure good memory management
            resetCssCache();
        }
        $('input:radio[name=contentInjectionMode]').prop('checked', false);
        $('input:radio[name=contentInjectionMode]').filter('[value="' + value + '"]').prop('checked', true);
        contentInjectionMode = value;
        // Save the value in a cookie, so that to be able to keep it after a reload/restart
        cookies.setItem('lastContentInjectionMode', value, Infinity);
        refreshCacheStatus();
    }
            
    // At launch, we try to set the last content injection mode (stored in a cookie)
    var lastContentInjectionMode = cookies.getItem('lastContentInjectionMode');
    if (lastContentInjectionMode) {
        setContentInjectionMode(lastContentInjectionMode);
    }
    else {
        setContentInjectionMode('jquery');
    }
    
    var serviceWorkerRegistration = null;
    
    // We need to establish the caching capabilities before first page launch
    refreshCacheStatus();
    
    /**
     * Tells if the ServiceWorker API is available
     * https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorker
     * @returns {Boolean}
     */
    function isServiceWorkerAvailable() {
        return ('serviceWorker' in navigator);
    }
    
    /**
     * Tells if the MessageChannel API is available
     * https://developer.mozilla.org/en-US/docs/Web/API/MessageChannel
     * @returns {Boolean}
     */
    function isMessageChannelAvailable() {
        try{
            var dummyMessageChannel = new MessageChannel();
            if (dummyMessageChannel) return true;
        }
        catch (e){
            return false;
        }
        return false;
    }
    
    /**
     * Tells if the ServiceWorker is registered, and ready to capture HTTP requests
     * and inject content in articles.
     * @returns {Boolean}
     */
    function isServiceWorkerReady() {
        // Return true if the serviceWorkerRegistration is not null and not undefined
        return (serviceWorkerRegistration);
    }
    
    /**
     * 
     * @type Array.<StorageFirefoxOS>
     */
    var storages = [];
    function searchForArchivesInPreferencesOrStorage() {
        // First see if the list of archives is stored in the cookie
        var listOfArchivesFromCookie = cookies.getItem("listOfArchives");
        if (listOfArchivesFromCookie !== null && listOfArchivesFromCookie !== undefined && listOfArchivesFromCookie !== "") {
            var directories = listOfArchivesFromCookie.split('|');
            populateDropDownListOfArchives(directories);
        }
        else {
            searchForArchivesInStorage();
        }
    }
    function searchForArchivesInStorage() {
        // If DeviceStorage is available, we look for archives in it
        $("#btnConfigure").click();
        $('#scanningForArchives').show();
        zimArchiveLoader.scanForArchives(storages, populateDropDownListOfArchives);
    }

    if ($.isFunction(navigator.getDeviceStorages)) {
        // The method getDeviceStorages is available (FxOS>=1.1)
        storages = $.map(navigator.getDeviceStorages("sdcard"), function(s) {
            return new abstractFilesystemAccess.StorageFirefoxOS(s);
        });
    }

    if (storages !== null && storages.length > 0) {
        // Make a fake first access to device storage, in order to ask the user for confirmation if necessary.
        // This way, it is only done once at this moment, instead of being done several times in callbacks
        // After that, we can start looking for archives
        storages[0].get("fake-file-to-read").then(searchForArchivesInPreferencesOrStorage,
                                                  searchForArchivesInPreferencesOrStorage);
    }
    else {
        // If DeviceStorage is not available, we display the file select components
        displayFileSelect();
        if (document.getElementById('archiveFiles').files && document.getElementById('archiveFiles').files.length>0) {
            // Archive files are already selected, 
            setLocalArchiveFromFileSelect();
        }
        else {
            $("#btnConfigure").click();
        }
    }


    // Display the article when the user goes back in the browser history
    window.onpopstate = function(event) {
        if (event.state) {
            var title = event.state.title;
            var titleSearch = event.state.titleSearch;
            
            $('#prefix').val("");
            $("#welcomeText").hide();
            $("#searchingArticles").hide();
            $('.navbar-collapse').collapse('hide');
            $('#configuration').hide();
            $('#articleListWithHeader').hide();
            $('#articleContent').contents().empty();
            
            if (title && !(""===title)) {
                goToArticle(title);
            }
            else if (titleSearch && !(""===titleSearch)) {
                $('#prefix').val(titleSearch);
                searchDirEntriesFromPrefix($('#prefix').val());
            }
        }
    };
    
    /**
     * Populate the drop-down list of archives with the given list
     * @param {Array.<String>} archiveDirectories
     */
    function populateDropDownListOfArchives(archiveDirectories) {
        $('#scanningForArchives').hide();
        $('#chooseArchiveFromLocalStorage').show();
        var comboArchiveList = document.getElementById('archiveList');
        comboArchiveList.options.length = 0;
        for (var i = 0; i < archiveDirectories.length; i++) {
            var archiveDirectory = archiveDirectories[i];
            if (archiveDirectory === "/") {
                alert("It looks like you have put some archive files at the root of your sdcard (or internal storage). Please move them in a subdirectory");
            }
            else {
                comboArchiveList.options[i] = new Option(archiveDirectory, archiveDirectory);
            }
        }
        // Store the list of archives in a cookie, to avoid rescanning at each start
        cookies.setItem("listOfArchives", archiveDirectories.join('|'), Infinity);
        
        $('#archiveList').on('change', setLocalArchiveFromArchiveList);
        if (comboArchiveList.options.length > 0) {
            var lastSelectedArchive = cookies.getItem("lastSelectedArchive");
            if (lastSelectedArchive !== null && lastSelectedArchive !== undefined && lastSelectedArchive !== "") {
                // Attempt to select the corresponding item in the list, if it exists
                if ($("#archiveList option[value='"+lastSelectedArchive+"']").length > 0) {
                    $("#archiveList").val(lastSelectedArchive);
                }
            }
            // Set the localArchive as the last selected (or the first one if it has never been selected)
            setLocalArchiveFromArchiveList();
        }
        else {
            alert("Welcome to Kiwix! This application needs at least a ZIM file in your SD-card (or internal storage). Please download one and put it on the device (see About section). Also check that your device is not connected to a computer through USB device storage (which often locks the SD-card content)");
            $("#btnAbout").click();
            var isAndroid = (navigator.userAgent.indexOf("Android") !== -1);
            if (isAndroid) {
                alert("You seem to be using an Android device. Be aware that there is a bug on Firefox, that prevents finding Wikipedia archives in a SD-card (at least on some devices. See about section). Please put the archive in the internal storage if the application can't find it.");
            }
        }
    }

    /**
     * Sets the localArchive from the selected archive in the drop-down list
     */
    function setLocalArchiveFromArchiveList() {
        var archiveDirectory = $('#archiveList').val();
        if (archiveDirectory && archiveDirectory.length > 0) {
            // Now, try to find which DeviceStorage has been selected by the user
            // It is the prefix of the archive directory
            var regexpStorageName = /^\/([^/]+)\//;
            var regexpResults = regexpStorageName.exec(archiveDirectory);
            var selectedStorage = null;
            if (regexpResults && regexpResults.length>0) {
                var selectedStorageName = regexpResults[1];
                for (var i=0; i<storages.length; i++) {
                    var storage = storages[i];
                    if (selectedStorageName === storage.storageName) {
                        // We found the selected storage
                        selectedStorage = storage;
                    }
                }
                if (selectedStorage === null) {
                    alert("Unable to find which device storage corresponds to directory " + archiveDirectory);
                }
            }
            else {
                // This happens when the archiveDirectory is not prefixed by the name of the storage
                // (in the Simulator, or with FxOs 1.0, or probably on devices that only have one device storage)
                // In this case, we use the first storage of the list (there should be only one)
                if (storages.length === 1) {
                    selectedStorage = storages[0];
                }
                else {
                    alert("Something weird happened with the DeviceStorage API : found a directory without prefix : "
                        + archiveDirectory + ", but there were " + storages.length
                        + " storages found with getDeviceStorages instead of 1");
                }
            }
            resetCssCache();
            selectedArchive = zimArchiveLoader.loadArchiveFromDeviceStorage(selectedStorage, archiveDirectory, function (archive) {
                cookies.setItem("lastSelectedArchive", archiveDirectory, Infinity);
                // The archive is set : go back to home page to start searching
                $("#btnHome").click();
            });
            
        }
    }
    
    /**
     * Resets the CSS Cache (used only in jQuery mode)
     */
    function resetCssCache() {
        // Reset the cssCache. Must be done when archive changes.
        if (cssCache) {
            cssCache = new Map();
        }
    }

    /**
     * Displays the zone to select files from the archive
     */
    function displayFileSelect() {
        document.getElementById('openLocalFiles').style.display = 'block';
        // Set the main drop zone
        configDropZone.addEventListener('dragover', handleGlobalDragover);
        configDropZone.addEventListener('dragleave', function(e) {
            configDropZone.style.border = '';
        });
        // Also set a global drop zone (allows us to ensure Config is always displayed for the file drop)
        globalDropZone.addEventListener('dragover', function(e) {
            e.preventDefault();
            if (configDropZone.style.display === 'none') document.getElementById('btnConfigure').click();
            e.dataTransfer.dropEffect = 'link';
        });
        globalDropZone.addEventListener('drop', handleFileDrop);
        // This handles use of the file picker
        document.getElementById('archiveFiles').addEventListener('change', setLocalArchiveFromFileSelect);
    }

    function handleGlobalDragover(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        configDropZone.style.border = '3px dotted red';
    }

    function handleIframeDragover(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        document.getElementById('btnConfigure').click();
    }

    function handleIframeDrop(e) {
        e.stopPropagation();
        e.preventDefault();
        return;
    }

    function handleFileDrop(packet) {
        packet.stopPropagation();
        packet.preventDefault();
        configDropZone.style.border = '';
        var files = packet.dataTransfer.files;
        document.getElementById('openLocalFiles').style.display = 'none';
        document.getElementById('downloadInstruction').style.display = 'none';
        document.getElementById('selectorsDisplay').style.display = 'inline';
        setLocalArchiveFromFileList(files);
        // This clears the display of any previously picked archive in the file selector
        document.getElementById('archiveFiles').value = null;
    }

    // Add event listener to link which allows user to show file selectors
    document.getElementById('selectorsDisplayLink').addEventListener('click', function(e) {
        e.preventDefault();
        document.getElementById('openLocalFiles').style.display = 'block';
        document.getElementById('selectorsDisplay').style.display = 'none';
    });

    function setLocalArchiveFromFileList(files) {
        // Check for usable file types
        for (var i = files.length; i--;) {
            // DEV: you can support other file types by adding (e.g.) '|dat|idx' after 'zim\w{0,2}'
            if (!/\.(?:zim\w{0,2})$/i.test(files[i].name)) {
                alert("One or more files does not appear to be a ZIM file!");
                return;
            }
        }
        resetCssCache();
        selectedArchive = zimArchiveLoader.loadArchiveFromFiles(files, function (archive) {
            // The archive is set : go back to home page to start searching
            $("#btnHome").click();
            document.getElementById('downloadInstruction').style.display = 'none';
        });
    }

    /**
     * Sets the localArchive from the File selects populated by user
     */
    function setLocalArchiveFromFileSelect() {
        setLocalArchiveFromFileList(document.getElementById('archiveFiles').files);
    }

    /**
     * Reads a remote archive with given URL, and returns the response in a Promise.
     * This function is used by setRemoteArchives below, for UI tests
     * 
     * @param url The URL of the archive to read
     * @returns {Promise}
     */
    function readRemoteArchive(url) {
        var deferred = q.defer();
        var request = new XMLHttpRequest();
        request.open("GET", url, true);
        request.responseType = "blob";
        request.onreadystatechange = function () {
            if (request.readyState === XMLHttpRequest.DONE) {
                if ((request.status >= 200 && request.status < 300) || request.status === 0) {
                    // Hack to make this look similar to a file
                    request.response.name = url;
                    deferred.resolve(request.response);
                }
                else {
                    deferred.reject("HTTP status " + request.status + " when reading " + url);
                }
            }
        };
        request.onabort = function (e) {
            deferred.reject(e);
        };
        request.send(null);
        return deferred.promise;
    }
    
    /**
     * This is used in the testing interface to inject remote archives
     */
    window.setRemoteArchives = function() {
        var readRequests = [];
        var i;
        for (i = 0; i < arguments.length; i++) {
            readRequests[i] = readRemoteArchive(arguments[i]);
        }
        return q.all(readRequests).then(function(arrayOfArchives) {
            setLocalArchiveFromFileList(arrayOfArchives);
        });
    };

    /**
     * Handle key input in the prefix input zone
     * @param {Event} evt
     */
    function onKeyUpPrefix(evt) {
        // Use a timeout, so that very quick typing does not cause a lot of overhead
        // It is also necessary for the words suggestions to work inside Firefox OS
        if(window.timeoutKeyUpPrefix) {
            window.clearTimeout(window.timeoutKeyUpPrefix);
        }
        window.timeoutKeyUpPrefix = window.setTimeout(function() {
            var prefix = $("#prefix").val();
            if (prefix && prefix.length>0) {
                $('#searchArticles').click();
            }
        }
        ,500);
    }

    /**
     * Update latestUserAsynAction.
     * @param {*} action : An action that can cause wrong dispalying due to race condition.
     * @param {*} actionIdentifier : The keyword used to perform action. Can be keyword for search or identifer for 
     * article to be displayed.
     */
    function updateLatestAsynAction(action, actionIdentifier){
        latestUserAsynAction.action = action;
        latestUserAsynAction.actionIdentifier = actionIdentifier;
        return {"action": action, "actionIdentifier": actionIdentifier};
    }

    /**
     * Search the index for DirEntries with title that start with the given prefix (implemented
     * with a binary search inside the index file)
     * @param {String} prefix
     */
    function searchDirEntriesFromPrefix(prefix) {
        if (selectedArchive !== null && selectedArchive.isReady()) {
            var curAction = updateLatestAsynAction("Search", prefix);

            $('#activeContent').hide();
            selectedArchive.findDirEntriesWithPrefix(prefix.trim(), MAX_SEARCH_RESULT_SIZE, function(archiveDirectories) {
                populateListOfArticles(curAction, archiveDirectories);
            });
        } else {
            $('#searchingArticles').hide();
            // We have to remove the focus from the search field,
            // so that the keyboard does not stay above the message
            $("#searchArticles").focus();
            alert("Archive not set : please select an archive");
            $("#btnConfigure").click();
        }
    }

  
    /**
     * Display the list of articles with the given array of DirEntry
     * @param {Object} originAction The action invoked this callback function.
     * @param {Array} dirEntryArray The array of dirEntries returned from the binary search
     */
    function populateListOfArticles(originAction, dirEntryArray) {
        if(! isThisCallbackExpectedToBePerformed(originAction)){
            return;
        }

        var articleListHeaderMessageDiv = $('#articleListHeaderMessage');
        var nbDirEntry = dirEntryArray ? dirEntryArray.length : 0;

        var message;
        if (nbDirEntry >= MAX_SEARCH_RESULT_SIZE) {
            message = 'First ' + MAX_SEARCH_RESULT_SIZE + ' articles below (refine your search).';
        } else {
            message = nbDirEntry + ' articles found.';
        }
        if (nbDirEntry === 0) {
            message = 'No articles found.';
        }

        articleListHeaderMessageDiv.html(message);

        var articleListDiv = $('#articleList');
        var articleListDivHtml = '';
        var listLength = dirEntryArray.length < MAX_SEARCH_RESULT_SIZE ? dirEntryArray.length : MAX_SEARCH_RESULT_SIZE;
        for (var i = 0; i < listLength; i++) {
            var dirEntry = dirEntryArray[i];
            var dirEntryStringId = uiUtil.htmlEscapeChars(dirEntry.toStringId());
            articleListDivHtml += '<a href="#" dirEntryId="' + dirEntryStringId +
                '" class="list-group-item">' + dirEntry.getTitleOrUrl() + '</a>';
        }
        articleListDiv.html(articleListDivHtml);
        // We have to use mousedown below instead of click as otherwise the prefix blur event fires first 
        // and prevents this event from firing; note that touch also triggers mousedown
        $('#articleList a').on('mousedown', function (e) {
            handleTitleClick(e);
            return false;
        });
        $('#searchingArticles').hide();
        $('#articleListWithHeader').show();
    }
    
    /**
     * Handles the click on the title of an article in search results
     * @param {Event} event
     * @returns {Boolean}
     */
    function handleTitleClick(event) {       
        var dirEntryId = event.target.getAttribute("dirEntryId");
        findDirEntryFromDirEntryIdAndLaunchArticleRead(dirEntryId);
        return false;
    }
    

    /**
     * Creates an instance of DirEntry from given dirEntryId (including resolving redirects),
     * and call the function to read the corresponding article
     * @param {String} dirEntryId
     */
    function findDirEntryFromDirEntryIdAndLaunchArticleRead(dirEntryId) {
        if (selectedArchive.isReady()) {
            var dirEntry = selectedArchive.parseDirEntryId(dirEntryId);
            // Remove focus from search field to hide keyboard and to allow navigation keys to be used
            document.getElementById('articleContent').contentWindow.focus();
            $("#searchingArticles").show();
            if (dirEntry.isRedirect()) {
                selectedArchive.resolveRedirect(dirEntry, readArticle);
            } else {
                params.isLandingPage = false;
                readArticle(dirEntry);
            }
        } else {
            alert("Data files not set");
        }
    }

    /**
     * Check whether the origin action equals the latest action latestAsynAction
     * @param {Object} originAction The action invoked the parent asyn callback functions 
     */
    function isThisCallbackExpectedToBePerformed(originAction) {
        if (originAction.action != latestUserAsynAction.action || originAction.actionIdentifier != latestUserAsynAction.actionIdentifier) {
            console.debug("Result of asyn action : " + originAction.action + ":" + originAction.actionIdentifier + " won't be displayed \
            since the latest asyn action is:" + latestUserAsynAction.action + ":" + latestUserAsynAction.actionIdentifier);
            return false;
        }
        return true;
    }

    /**
     * Read the article corresponding to the given dirEntry
     * @param {DirEntry} dirEntry The directory entry of the article to read
     */
    function readArticle(dirEntry) {
        var curAction = updateLatestAsynAction("Read",  dirEntry.namespace + "/" + dirEntry.url);

        // We must remove focus from UI elements in order to deselect whichever one was clicked (in both jQuery and SW modes),
        // but we should not do this when opening the landing page (or else one of the Unit Tests fails, at least on Chrome 58)
        if (!params.isLandingPage) document.getElementById('articleContent').contentWindow.focus();

        if (contentInjectionMode === 'serviceworker') {
            // In ServiceWorker mode, we simply set the iframe src.
            // (reading the backend is handled by the ServiceWorker itself)

            // We will need the encoded URL on article load so that we can set the iframe's src correctly,
            // but we must not encode the '/' character or else relative links may fail [kiwix-js #498]
            var encodedUrl = dirEntry.url.replace(/[^/]+/g, function (matchedSubstring) {
                return encodeURIComponent(matchedSubstring);
            });
            var iframeArticleContent = document.getElementById('articleContent');
            iframeArticleContent.onload = function () {
                // The content is fully loaded by the browser : we can hide the spinner
                $("#cachingAssets").html("Caching assets...");
                $("#cachingAssets").hide();
                $("#searchingArticles").hide();
                // Set the requested appTheme
                uiUtil.applyAppTheme(params.appTheme);
                // Display the iframe content
                $("#articleContent").show();
                // Deflect drag-and-drop of ZIM file on the iframe to Config
                var doc = iframeArticleContent.contentDocument ? iframeArticleContent.contentDocument.documentElement : null;
                var docBody = doc ? doc.getElementsByTagName('body') : null;
                docBody = docBody ? docBody[0] : null;
                if (docBody) {
                    docBody.addEventListener('dragover', handleIframeDragover);
                    docBody.addEventListener('drop', handleIframeDrop);
                }
                // Reset UI when the article is unloaded
                if (iframeArticleContent.contentWindow) iframeArticleContent.contentWindow.onunload = function () {
                    $("#articleList").empty();
                    $('#articleListHeaderMessage').empty();
                    $('#articleListWithHeader').hide();
                    $("#prefix").val("");
                    $("#searchingArticles").show();
                };
            };


            // We put the ZIM filename as a prefix in the URL, so that browser caches are separate for each ZIM file
            iframeArticleContent.src = "../" + selectedArchive._file._files[0].name + "/" + dirEntry.namespace + "/" + encodedUrl;
        } else {
            // In jQuery mode, we read the article content in the backend and manually insert it in the iframe
            if (dirEntry.isRedirect()) {
                selectedArchive.resolveRedirect(dirEntry, readArticle);
            } else {
                // Line below was inserted to prevent the spinner being hidden, possibly by an async function, when pressing the Random button in quick succession
                // TODO: Investigate whether it is really an async issue or whether there is a rogue .hide() statement in the chain
                $("#searchingArticles").show();
                selectedArchive.readUtf8File(dirEntry, function (dirEntry, htmlArticle) {
                    displayArticleContentInIframe(curAction, dirEntry, htmlArticle);
                });
            }
        }
    }
    
    var messageChannel;
    
    /**
     * Function that handles a message of the messageChannel.
     * It tries to read the content in the backend, and sends it back to the ServiceWorker
     * 
     * @param {Event} event The event object of the message channel
     */
    function handleMessageChannelMessage(event) {
        if (event.data.error) {
            console.error("Error in MessageChannel", event.data.error);
            reject(event.data.error);
        } else {
            // We received a message from the ServiceWorker
            if (event.data.action === "askForContent") {
                // The ServiceWorker asks for some content
                var title = event.data.title;
                var messagePort = event.ports[0];
                var readFile = function (dirEntry) {
                    if (dirEntry === null) {
                        console.error("Title " + title + " not found in archive.");
                        messagePort.postMessage({ 'action': 'giveContent', 'title': title, 'content': '' });
                    } else if (dirEntry.isRedirect()) {
                        selectedArchive.resolveRedirect(dirEntry, function (resolvedDirEntry) {
                            var redirectURL = resolvedDirEntry.namespace + "/" + resolvedDirEntry.url;
                            // Ask the ServiceWork to send an HTTP redirect to the browser.
                            // We could send the final content directly, but it is necessary to let the browser know in which directory it ends up.
                            // Else, if the redirect URL is in a different directory than the original URL,
                            // the relative links in the HTML content would fail. See #312
                            messagePort.postMessage({ 'action': 'sendRedirect', 'title': title, 'redirectUrl': redirectURL });
                        });
                    } else {
                        // Let's read the content in the ZIM file
                        selectedArchive.readBinaryFile(dirEntry, function (fileDirEntry, content) {
                            var mimetype = fileDirEntry.getMimetype();
                            // Let's send the content to the ServiceWorker
                            var message = { 'action': 'giveContent', 'title': title, 'content': content.buffer, 'mimetype': mimetype };
                            messagePort.postMessage(message, [content.buffer]);
                        });
                    }
                };
                selectedArchive.getDirEntryByTitle(title).then(readFile).fail(function () {
                    messagePort.postMessage({ 'action': 'giveContent', 'title': title, 'content': new UInt8Array() });
                });
            } else {
                console.error("Invalid message received", event.data);
            }
        }
    }
    
    // Compile some regular expressions needed to modify links
    // Pattern to find a ZIM URL (with its namespace) - see https://wiki.openzim.org/wiki/ZIM_file_format#Namespaces
    var regexpZIMUrlWithNamespace = /^[./]*([-ABIJMUVWX]\/.+)$/;
    // Regex below finds images, scripts, stylesheets and tracks with ZIM-type metadata and image namespaces [kiwix-js #378]
    // It first searches for <img, <script, <link, etc., then scans forward to find, on a word boundary, either src=["']
    // or href=["'] (ignoring any extra whitespace), and it then tests the path of the URL with a non-capturing lookahead that
    // matches ZIM URLs with namespaces [-IJ] ('-' = metadata or 'I'/'J' = image). When the regex is used below, it will also
    // remove any relative or absolute path from ZIM-style URLs.
    // DEV: If you want to support more namespaces, add them to the END of the character set [-IJ] (not to the beginning) 
    var regexpTagsWithZimUrl = /(<(?:img|script|link|track)\b[^>]*?\s)(?:src|href)(\s*=\s*["'])(?:\.\.\/|\/)+(?=[-IJ]\/)/ig;
    // Regex below tests the html of an article for active content [kiwix-js #466]
    // It inspects every <script> block in the html and matches in the following cases: 1) the script loads a UI application called app.js;
    // 2) the script block has inline content that does not contain "importScript()" or "toggleOpenSection" (these strings are used widely
    // in our fully supported wikimedia ZIMs, so they are excluded); 3) the script block is not of type "math" (these are MathJax markup
    // scripts used extensively in Stackexchange ZIMs). Note that the regex will match ReactJS <script type="text/html"> markup, which is
    // common in unsupported packaged UIs, e.g. PhET ZIMs.
    var regexpActiveContent = /<script\b(?:(?![^>]+src\b)|(?=[^>]+src\b=["'][^"']+?app\.js))(?!>[^<]+(?:importScript\(\)|toggleOpenSection))(?![^>]+type\s*=\s*["'](?:math\/|[^"']*?math))/i;
    
    // DEV: The regex below matches ZIM links (anchor hrefs) that should have the html5 "donwnload" attribute added to 
    // the link. This is currently the case for epub and pdf files in Project Gutenberg ZIMs -- add any further types you need
    // to support to this regex. The "zip" has been added here as an example of how to support further filetypes
    var regexpDownloadLinks = /^.*?\.epub($|\?)|^.*?\.pdf($|\?)|^.*?\.zip($|\?)/i;
    
    /**
     * Display the the given HTML article in the web page,
     * and convert links to javascript calls
     * NB : in some error cases, the given title can be null, and the htmlArticle contains the error message
     * @param {Object}  originAction  The action to invoke this callback function.
     * @param {DirEntry} dirEntry
     * @param {String} htmlArticle
     */
    function displayArticleContentInIframe(originAction, dirEntry, htmlArticle) {
        if(! isThisCallbackExpectedToBePerformed(originAction)){
            return;
        }		
        // Display Bootstrap warning alert if the landing page contains active content
        if (!params.hideActiveContentWarning && params.isLandingPage) {
            if (regexpActiveContent.test(htmlArticle)) uiUtil.displayActiveContentWarning();
        }

        // Replaces ZIM-style URLs of img, script, link and media tags with a data-kiwixurl to prevent 404 errors [kiwix-js #272 #376]
        // This replacement also processes the URL to remove the path so that the URL is ready for subsequent jQuery functions
        htmlArticle = htmlArticle.replace(regexpTagsWithZimUrl, '$1data-kiwixurl$2');

        // Extract any css classes from the html tag (they will be stripped when injected in iframe with .innerHTML)
        var htmlCSS = htmlArticle.match(/<html[^>]*class\s*=\s*["']\s*([^"']+)/i);
        htmlCSS = htmlCSS ? htmlCSS[1] : '';
        
        // Tell jQuery we're removing the iframe document: clears jQuery cache and prevents memory leaks [kiwix-js #361]
        $('#articleContent').contents().remove();

        // Hide any alert box that was activated in uiUtil.displayFileDownloadAlert function
        $('#downloadAlert').hide();

        var iframeArticleContent = document.getElementById('articleContent');
        
        iframeArticleContent.onload = function() {
            iframeArticleContent.onload = function(){};
            $("#articleList").empty();
            $('#articleListHeaderMessage').empty();
            $('#articleListWithHeader').hide();
            $("#prefix").val("");
            
            var iframeContentDocument = iframeArticleContent.contentDocument;
            if (!iframeContentDocument && window.location.protocol === 'file:') {
                alert("You seem to be opening kiwix-js with the file:// protocol, which is blocked by your browser for security reasons."
                        + "\nThe easiest way to run it is to download and run it as a browser extension (from the vendor store)."
                        + "\nElse you can open it through a web server : either through a local one (http://localhost/...) or through a remote one (but you need SSL : https://webserver/...)"
                        + "\nAnother option is to force your browser to accept that (but you'll open a security breach) : on Chrome, you can start it with --allow-file-access-from-files command-line argument; on Firefox, you can set privacy.file_unique_origin to false in about:config");
                return;
            }
            
            // Inject the new article's HTML into the iframe
            var articleContent = iframeContentDocument.documentElement;
            articleContent.innerHTML = htmlArticle;
            
            var docBody = articleContent.getElementsByTagName('body');
            docBody = docBody ? docBody[0] : null;
            if (docBody) {
                // Add any missing classes stripped from the <html> tag
                if (htmlCSS) docBody.classList.add(htmlCSS);
                // Deflect drag-and-drop of ZIM file on the iframe to Config
                docBody.addEventListener('dragover', handleIframeDragover);
                docBody.addEventListener('drop', handleIframeDrop);
            }
            // Set the requested appTheme
            uiUtil.applyAppTheme(params.appTheme);
            // Allow back/forward in browser history
            pushBrowserHistoryState(dirEntry.namespace + "/" + dirEntry.url);

            parseAnchorsJQuery();
            loadImagesJQuery();
            // JavaScript is currently disabled, so we need to make the browser interpret noscript tags
            // NB : if javascript is properly handled in jQuery mode in the future, this call should be removed
            // and noscript tags should be ignored
            loadNoScriptTags();
            //loadJavaScriptJQuery();
            loadCSSJQuery();
            insertMediaBlobsJQuery();
        };
     
        // Load the blank article to clear the iframe (NB iframe onload event runs *after* this)
        iframeArticleContent.src = "article.html";

        // Calculate the current article's ZIM baseUrl to use when processing relative links
        var baseUrl = dirEntry.namespace + '/' + dirEntry.url.replace(/[^/]+$/, '');

        function parseAnchorsJQuery() {
            var currentProtocol = location.protocol;
            var currentHost = location.host;
            // Percent-encode dirEntry.url and add regex escape character \ to the RegExp special characters - see https://www.regular-expressions.info/characters.html;
            // NB dirEntry.url can also contain path separator / in some ZIMs (Stackexchange). } and ] do not need to be escaped as they have no meaning on their own. 
            var escapedUrl = encodeURIComponent(dirEntry.url).replace(/([\\$^.|?*+/()[{])/g, '\\$1');
            // Pattern to match a local anchor in an href even if prefixed by escaped url; will also match # on its own
            var regexpLocalAnchorHref = new RegExp('^(?:#|' + escapedUrl + '#)([^#]*$)');
            var iframe = iframeArticleContent.contentDocument;
            Array.prototype.slice.call(iframe.querySelectorAll('a, area')).forEach(function (anchor) {
                // Attempts to access any properties of 'this' with malformed URLs causes app crash in Edge/UWP [kiwix-js #430]
                try {
                    var testHref = anchor.href;
                } catch (err) {
                    console.error('Malformed href caused error:' + err.message);
                    return;
                }
                var href = anchor.getAttribute('href');
                if (href === null || href === undefined) return;
                if (href.length === 0) {
                    // It's a link with an empty href, pointing to the current page: do nothing.
                } else if (regexpLocalAnchorHref.test(href)) {
                    // It's a local anchor link : remove escapedUrl if any (see above)
                    anchor.setAttribute('href', href.replace(/^[^#]*/, ''));
                } else if (anchor.protocol !== currentProtocol ||
                    anchor.host !== currentHost) {
                    // It's an external URL : we should open it in a new tab
                    anchor.target = '_blank';
                } else {
                    // It's a link to an article or file in the ZIM
                    var uriComponent = uiUtil.removeUrlParameters(href);
                    var contentType;
                    var downloadAttrValue;
                    // Some file types need to be downloaded rather than displayed (e.g. *.epub)
                    // The HTML download attribute can be Boolean or a string representing the specified filename for saving the file
                    // For Boolean values, getAttribute can return any of the following: download="" download="download" download="true"
                    // So we need to test hasAttribute first: see https://developer.mozilla.org/en-US/docs/Web/API/Element/getAttribute
                    // However, we cannot rely on the download attribute having been set, so we also need to test for known download file types
                    var isDownloadableLink = anchor.hasAttribute('download') || regexpDownloadLinks.test(href);
                    if (isDownloadableLink) {
                        downloadAttrValue = anchor.getAttribute('download');
                        // Normalize the value to a true Boolean or a filename string or true if there is no download attribute
                        downloadAttrValue = /^(download|true|\s*)$/i.test(downloadAttrValue) || downloadAttrValue || true;
                        contentType = anchor.getAttribute('type');
                    }
                    // Add an onclick event to extract this article or file from the ZIM
                    // instead of following the link
                    anchor.addEventListener('click', function (e) {
                        var zimUrl = uiUtil.deriveZimUrlFromRelativeUrl(uriComponent, baseUrl);
                        goToArticle(zimUrl, downloadAttrValue, contentType);
                        e.preventDefault();
                    });
                }
            });
        }
        
        function loadImagesJQuery() {
            $('#articleContent').contents().find('body').find('img[data-kiwixurl]').each(function() {
                var image = $(this);
                var imageUrl = image.attr("data-kiwixurl");
                var title = decodeURIComponent(imageUrl);
                selectedArchive.getDirEntryByTitle(title).then(function(dirEntry) {
                    selectedArchive.readBinaryFile(dirEntry, function (fileDirEntry, content) {
                        var mimetype = dirEntry.getMimetype();
                        uiUtil.feedNodeWithBlob(image, 'src', content, mimetype);
                    });
                }).fail(function (e) {
                    console.error("could not find DirEntry for image:" + title, e);
                });
            });
        }
        
        function loadNoScriptTags() {
            // For each noscript tag, we replace it with its content, so that the browser interprets it
            $('#articleContent').contents().find('noscript').replaceWith(function () {
                // When javascript is enabled, browsers interpret the content of noscript tags as text
                // (see https://html.spec.whatwg.org/multipage/scripting.html#the-noscript-element)
                // So we can read this content with .textContent
                return this.textContent;
            });
        }

        function loadCSSJQuery() {
            // Ensure all sections are open for clients that lack JavaScript support, or that have some restrictive CSP [kiwix-js #355].
            // This is needed only for some versions of ZIM files generated by mwoffliner (at least in early 2018), where the article sections are closed by default on small screens.
            // These sections can be opened by clicking on them, but this is done with some javascript.
            // The code below is a workaround we still need for compatibility with ZIM files generated by mwoffliner in 2018.
            // A better fix has been made for more recent ZIM files, with the use of noscript tags : see https://github.com/openzim/mwoffliner/issues/324
            var iframe = document.getElementById('articleContent').contentDocument;
            var collapsedBlocks = iframe.querySelectorAll('.collapsible-block:not(.open-block), .collapsible-heading:not(.open-block)');
            // Using decrementing loop to optimize performance : see https://stackoverflow.com/questions/3520688 
            for (var i = collapsedBlocks.length; i--;) {
                collapsedBlocks[i].classList.add('open-block');
            }

            var cssCount = 0;
            var cssFulfilled = 0;
            $('#articleContent').contents().find('link[data-kiwixurl]').each(function () {
                cssCount++;
                var link = $(this);
                var linkUrl = link.attr("data-kiwixurl");
                var title = uiUtil.removeUrlParameters(decodeURIComponent(linkUrl));
                if (cssCache.has(title)) {
                    var cssContent = cssCache.get(title);
                    uiUtil.replaceCSSLinkWithInlineCSS(link, cssContent);
                    cssFulfilled++;
                } else {
                    if (params.useCache) $('#cachingAssets').show();
                    selectedArchive.getDirEntryByTitle(title)
                    .then(function (dirEntry) {
                        return selectedArchive.readUtf8File(dirEntry,
                            function (fileDirEntry, content) {
                                var fullUrl = fileDirEntry.namespace + "/" + fileDirEntry.url;
                                if (params.useCache) cssCache.set(fullUrl, content);
                                uiUtil.replaceCSSLinkWithInlineCSS(link, content);
                                cssFulfilled++;
                                renderIfCSSFulfilled(fileDirEntry.url);
                            }
                        );
                    }).fail(function (e) {
                        console.error("could not find DirEntry for CSS : " + title, e);
                        cssCount--;
                        renderIfCSSFulfilled();
                    });
                }
            });
            renderIfCSSFulfilled();

            // Some pages are extremely heavy to render, so we prevent rendering by keeping the iframe hidden
            // until all CSS content is available [kiwix-js #381]
            function renderIfCSSFulfilled(title) {
                if (cssFulfilled >= cssCount) {
                    $('#cachingAssets').html('Caching assets...');
                    $('#cachingAssets').hide();
                    $('#searchingArticles').hide();
                    $('#articleContent').show();
                    // We have to resize here for devices with On Screen Keyboards when loading from the article search list
                    resizeIFrame();
                } else {
                    updateCacheStatus(title);
                }
            }
        }

        function loadJavaScriptJQuery() {
            $('#articleContent').contents().find('script[data-kiwixurl]').each(function() {
                var script = $(this);
                var scriptUrl = script.attr("data-kiwixurl");
                // TODO check that the type of the script is text/javascript or application/javascript
                var title = uiUtil.removeUrlParameters(decodeURIComponent(scriptUrl));
                selectedArchive.getDirEntryByTitle(title).then(function(dirEntry) {
                    if (dirEntry === null) {
                        console.log("Error: js file not found: " + title);
                    } else {
                        selectedArchive.readBinaryFile(dirEntry, function (fileDirEntry, content) {
                            // TODO : JavaScript support not yet functional [kiwix-js #152]
                            uiUtil.feedNodeWithBlob(script, 'src', content, 'text/javascript');
                        });
                    }
                }).fail(function (e) {
                    console.error("could not find DirEntry for javascript : " + title, e);
                });
            });
        }

        function insertMediaBlobsJQuery() {
            var iframe = iframeArticleContent.contentDocument;
            Array.prototype.slice.call(iframe.querySelectorAll('video, audio, source, track'))
            .forEach(function(mediaSource) {
                var source = mediaSource.getAttribute('src');
                source = source ? uiUtil.deriveZimUrlFromRelativeUrl(source, baseUrl) : null;
                // We have to exempt text tracks from using deriveZimUrlFromRelativeurl due to a bug in Firefox [kiwix-js #496]
                source = source ? source : mediaSource.dataset.kiwixurl;
                if (!source || !regexpZIMUrlWithNamespace.test(source)) {
                    if (source) console.error('No usable media source was found for: ' + source);
                    return;
                }
                var mediaElement = /audio|video/i.test(mediaSource.tagName) ? mediaSource : mediaSource.parentElement;
                selectedArchive.getDirEntryByTitle(decodeURIComponent(source)).then(function(dirEntry) {
                    return selectedArchive.readBinaryFile(dirEntry, function (fileDirEntry, mediaArray) {
                        var mimeType = mediaSource.type ? mediaSource.type : dirEntry.getMimetype();
                        var blob = new Blob([mediaArray], { type: mimeType });
                        mediaSource.src = URL.createObjectURL(blob);
                        // In Firefox and Chromium it is necessary to re-register the inserted media source
                        // but do not reload for text tracks (closed captions / subtitles)
                        if (/track/i.test(mediaSource.tagName)) return;
                        mediaElement.load();
                    });
                });
            });
        }
    }

    /**
     * Displays a message to the user that a style or other asset is being cached
     * @param {String} title The title of the file to display in the caching message block 
     */
    function updateCacheStatus(title) {
        if (params.useCache && /\.css$|\.js$/i.test(title)) {
            var cacheBlock = document.getElementById('cachingAssets');
            cacheBlock.style.display = 'block';
            title = title.replace(/[^/]+\//g, '').substring(0,18);
            cacheBlock.innerHTML = 'Caching ' + title + '...';
        }
    }

    /**
     * Changes the URL of the browser page, so that the user might go back to it
     * 
     * @param {String} title
     * @param {String} titleSearch
     */
    function pushBrowserHistoryState(title, titleSearch) {
        var stateObj = {};
        var urlParameters;
        var stateLabel;
        if (title && !(""===title)) {
            // Prevents creating a double history for the same page
            if (history.state && history.state.title === title) return;
            stateObj.title = title;
            urlParameters = "?title=" + title;
            stateLabel = "Wikipedia Article : " + title;
        }
        else if (titleSearch && !(""===titleSearch)) {
            stateObj.titleSearch = titleSearch;
            urlParameters = "?titleSearch=" + titleSearch;
            stateLabel = "Wikipedia search : " + titleSearch;
        }
        else {
            return;
        }
        window.history.pushState(stateObj, stateLabel, urlParameters);
    }


    /**
     * Extracts the content of the given article title, or a downloadable file, from the ZIM
     * 
     * @param {String} title The path and filename to the article or file to be extracted
     * @param {Boolean|String} download A Bolean value that will trigger download of title, or the filename that should
     *     be used to save the file in local FS (in HTML5 spec, a string value for the download attribute is optional)
     * @param {String} contentType The mimetype of the downloadable file, if known 
     */
    function goToArticle(title, download, contentType) {
        $("#searchingArticles").show();
        selectedArchive.getDirEntryByTitle(title).then(function(dirEntry) {
            if (dirEntry === null || dirEntry === undefined) {
                $("#searchingArticles").hide();
                alert("Article with title " + title + " not found in the archive");
            } else if (download) {
                selectedArchive.readBinaryFile(dirEntry, function (fileDirEntry, content) {
                    var mimetype = contentType || fileDirEntry.getMimetype();
                    uiUtil.displayFileDownloadAlert(title, download, mimetype, content);
                });
            } else {
                params.isLandingPage = false;
                $('#activeContent').hide();
                readArticle(dirEntry);
            }
        }).fail(function(e) { alert("Error reading article with title " + title + " : " + e); });
    }
    
    function goToRandomArticle() {
        $("#searchingArticles").show();
        selectedArchive.getRandomDirEntry(function(dirEntry) {
            if (dirEntry === null || dirEntry === undefined) {
                $("#searchingArticles").hide();
                alert("Error finding random article.");
            } else {
                if (dirEntry.namespace === 'A') {
                    params.isLandingPage = false;
                    $('#activeContent').hide();
                    $('#searchingArticles').show();
                    readArticle(dirEntry);
                } else {
                    // If the random title search did not end up on an article,
                    // we try again, until we find one
                    goToRandomArticle();
                }
            }
        });
    }
    
    function goToMainArticle() {
        $("#searchingArticles").show();
        selectedArchive.getMainPageDirEntry(function(dirEntry) {
            if (dirEntry === null || dirEntry === undefined) {
                console.error("Error finding main article.");
                $("#searchingArticles").hide();
                $("#welcomeText").show();
            } else {
                if (dirEntry.namespace === 'A') {
                    params.isLandingPage = true;
                    readArticle(dirEntry);
                } else {
                    console.error("The main page of this archive does not seem to be an article");
                    $("#searchingArticles").hide();
                    $("#welcomeText").show();
                }
            }
        });
    }

});
