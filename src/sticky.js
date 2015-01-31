/**
 * Sticky States makes entire state trees "sticky". Sticky state trees are retained until their parent state is
 * exited. This can be useful to allow multiple modules, peers to each other, each module having its own independent
 * state tree.  The peer modules can be activated and inactivated without any loss of their internal context, including
 * DOM content such as unvalidated/partially filled in forms, and even scroll position.
 *
 * DOM content is retained by declaring a named ui-view in the parent state, and filling it in with a named view from the
 * sticky state.
 *
 * Technical overview:
 *
 * ---PATHS---
 * UI-Router uses state paths to manage entering and exiting of individual states.  Each state "A.B.C.X" has its own path, starting
 * from the root state ("") and ending at the state "X".  The path is composed the final state "X"'s ancestors, e.g.,
 * [ "", "A", "B", "C", "X" ].
 *
 * When a transition is processed, the previous path (fromState.path) is compared with the requested destination path
 * (toState.path).  All states that the from and to paths have in common are "kept" during the transition.  The last
 * "kept" element in the path is the "pivot".
 *
 * ---VIEWS---
 * A View in UI-Router consists of a controller and a template.  Each view belongs to one state, and a state can have many
 * views.  Each view plugs into a ui-view element in the DOM of one of the parent state's view(s).
 *
 * View context is managed in UI-Router using a 'state locals' concept. When a state's views are fully loaded, those views
 * are placed on the states 'locals' object.  Each locals object prototypally inherits from its parent state's locals object.
 * This means that state "A.B.C.X"'s locals object also has all of state "A.B.C"'s locals as well as those from "A.B" and "A".
 * The root state ("") defines no views, but it is included in the protypal inheritance chain.
 *
 * The locals object is used by the ui-view directive to load the template, render the content, create the child scope,
 * initialize the controller, etc.  The ui-view directives caches the locals in a closure variable.  If the locals are
 * identical (===), then the ui-view directive exits early, and does no rendering.
 *
 * In stock UI-Router, when a state is exited, that state's locals object is deleted and those views are cleaned up by
 * the ui-view directive shortly.
 *
 * ---Sticky States---
 * UI-Router Extras keeps views for inactive states live, even when UI-Router thinks it has exited them.  It does this
 * by creating a pseudo state called "__inactives" that is the parent of the root state.  It also then defines a locals
 * object on the "__inactives" state, which the root state protoypally inherits from.  By doing this, views for inactive
 * states are accessible through locals object's protoypal inheritance chain from any state in the system.
 *
 * ---Transitions---
 * UI-Router Extras decorates the $state.transitionTo function.  While a transition is in progress, the toState and
 * fromState internal state representations are modified in order to coerce stock UI-Router's transitionTo() into performing
 * the appropriate operations.  When the transition promise is completed, the original toState and fromState values are
 * restored.
 *
 * Stock UI-Router's $state.transitionTo function uses toState.path and fromState.path to manage entering and exiting
 * states.  UI-Router Extras takes advantage of those internal implementation details and prepares a toState.path and
 * fromState.path which coerces UI-Router into entering and exiting the correct states, or more importantly, not entering
 * and not exiting inactive or sticky states.  It also replaces state.self.onEnter and state.self.onExit for elements in
 * the paths when they are being inactivated or reactivated.
 */



// ------------------------ Sticky State module-level variables -----------------------------------------------
var _StickyState; // internal reference to $stickyStateProvider
var internalStates = {}; // Map { statename -> InternalStateObj } holds internal representation of all states
var root, // Root state, internal representation
  pendingTransitions = [], // One transition may supersede another.  This holds references to all pending transitions
  pendingRestore, // The restore function from the superseded transition
  inactivePseudoState, // This pseudo state holds all the inactive states' locals (resolved state data, such as views etc)
  versionHeuristics = { // Heuristics used to guess the current UI-Router Version
    hasParamSet: false
  };

// Creates a blank surrogate state
function SurrogateState(type) {
  return {
    resolve: { },
    locals: {
      globals: root && root.locals && root.locals.globals
    },
    views: { },
    self: { },
    params: { },
    ownParams: ( versionHeuristics.hasParamSet ? { $$equals: function() { return true; } } : []),
    surrogateType: type
  };
}

// ------------------------ Sticky State registration and initialization code ----------------------------------
// Grab a copy of the $stickyState service for use by the transition management code
angular.module("ct.ui.router.extras.sticky").run(["$stickyState", function ($stickyState) {
  _StickyState = $stickyState;
}]);

angular.module("ct.ui.router.extras.sticky").config(
  [ "$provide", "$stateProvider", '$stickyStateProvider', '$urlMatcherFactoryProvider', 'uirextras_coreProvider',
    function ($provide, $stateProvider, $stickyStateProvider, $urlMatcherFactoryProvider, uirextras_coreProvider) {
      var internalStates = uirextras_coreProvider.internalStates;

      versionHeuristics.hasParamSet = !!$urlMatcherFactoryProvider.ParamSet;
      // inactivePseudoState (__inactives) holds all the inactive locals which includes resolved states data, i.e., views, scope, etc
      inactivePseudoState = angular.extend(new SurrogateState("__inactives"), { self: {  name: '__inactives'  } });
      // Reset other module scoped variables.  This is to primarily to flush any previous state during karma runs.
      root = pendingRestore = undefined;
      pendingTransitions = [];

      uirextras_coreProvider.onStateRegistered(function(state) {
        // Register the ones marked as "sticky"
        if (state.self.sticky === true) {
          $stickyStateProvider.registerStickyState(state.self);
        }
      });

      var $state_transitionTo; // internal reference to the real $state.transitionTo function
      // Decorate the $state service, so we can decorate the $state.transitionTo() function with sticky state stuff.
      $provide.decorator("$state", ['$delegate', '$log', '$q', function ($state, $log, $q) {
        // Note: this code gets run only on the first state that is decorated
        root = $state.$current;
        internalStates[""] = root;
        root.parent = inactivePseudoState; // Make inactivePsuedoState the parent of root.  "wat"
        inactivePseudoState.parent = undefined; // Make inactivePsuedoState the real root.
        root.locals = inherit(inactivePseudoState.locals, root.locals); // make root locals extend the __inactives locals.
        delete inactivePseudoState.locals.globals;

        // Hold on to the real $state.transitionTo in a module-scope variable.
        $state_transitionTo = $state.transitionTo;

        // ------------------------ Decorated transitionTo implementation begins here ---------------------------
        $state.transitionTo = function (to, toParams, options) {
          var DEBUG = $stickyStateProvider.debugMode();
          // TODO: Move this to module.run?
          // TODO: I'd rather have root.locals prototypally inherit from inactivePseudoState.locals
          // Link root.locals and inactives.locals.  Do this at runtime, after root.locals has been set.
          if (!inactivePseudoState.locals)
            inactivePseudoState.locals = root.locals;
          var idx = pendingTransitions.length;
          if (pendingRestore) {
            pendingRestore();
            if (DEBUG) {
              $log.debug("Restored paths from pending transition");
            }
          }

          var fromState = $state.$current, fromParams = $state.params;
          var rel = options && options.relative || $state.$current; // Not sure if/when $state.$current is appropriate here.
          var toStateSelf = $state.get(to, rel); // exposes findState relative path functionality, returns state.self
          var savedToStatePath, savedFromStatePath, stickyTransitions;
          var reactivated = [], exited = [], terminalReactivatedState;
          toParams = toParams || {};
          arguments[1] = toParams;

          var noop = function () {
          };
          // Sticky states works by modifying the internal state objects of toState and fromState, especially their .path(s).
          // The restore() function is a closure scoped function that restores those states' definitions to their original values.
          var restore = function () {
            if (savedToStatePath) {
              toState.path = savedToStatePath;
              savedToStatePath = null;
            }

            if (savedFromStatePath) {
              fromState.path = savedFromStatePath;
              savedFromStatePath = null;
            }

            angular.forEach(restore.restoreFunctions, function (restoreFunction) {
              restoreFunction();
            });
            // Restore is done, now set the restore function to noop in case it gets called again.
            restore = noop;
            // pendingRestore keeps track of a transition that is in progress.  It allows the decorated transitionTo
            // method to be re-entrant (for example, when superceding a transition, i.e., redirect).  The decorated
            // transitionTo checks right away if there is a pending transition in progress and restores the paths
            // if so using pendingRestore.
            pendingRestore = null;
            pendingTransitions.splice(idx, 1); // Remove this transition from the list
          };

          // All decorated transitions have their toState.path and fromState.path replaced.  Surrogate states also make
          // additional changes to the states definition before handing the transition off to UI-Router. In particular,
          // certain types of surrogate states modify the state.self object's onEnter or onExit callbacks.
          // Those surrogate states must then register additional restore steps using restore.addRestoreFunction(fn)
          restore.restoreFunctions = [];
          restore.addRestoreFunction = function addRestoreFunction(fn) {
            this.restoreFunctions.push(fn);
          };


          // --------------------- Surrogate State Functions ------------------------
          // During a transition, the .path arrays in toState and fromState are replaced.  Individual path elements
          // (states) which aren't being "kept" are replaced with surrogate elements (states).  This section of the code
          // has factory functions for all the different types of surrogate states.


          function stateReactivatedSurrogatePhase1(state) {
            var surrogate = angular.extend(new SurrogateState("reactivate_phase1"), { locals: state.locals });
            surrogate.self = angular.extend({}, state.self);
            return surrogate;
          }

          function stateReactivatedSurrogatePhase2(state) {
            var surrogate = angular.extend(new SurrogateState("reactivate_phase2"), state);
            var oldOnEnter = surrogate.self.onEnter;
            surrogate.resolve = {}; // Don't re-resolve when reactivating states (fixes issue #22)
            // TODO: Not 100% sure if this is necessary.  I think resolveState will load the views if I don't do this.
            surrogate.views = {}; // Don't re-activate controllers when reactivating states (fixes issue #22)
            surrogate.self.onEnter = function () {
              // ui-router sets locals on the surrogate to a blank locals (because we gave it nothing to resolve)
              // Re-set it back to the already loaded state.locals here.
              surrogate.locals = state.locals;
              _StickyState.stateReactivated(state);
            };
            restore.addRestoreFunction(function () {
              state.self.onEnter = oldOnEnter;
            });
            return surrogate;
          }

          function stateInactivatedSurrogate(state) {
            var surrogate = new SurrogateState("inactivate");
            surrogate.self = state.self;
            var oldOnExit = state.self.onExit;
            surrogate.self.onExit = function () {
              _StickyState.stateInactivated(state);
            };
            restore.addRestoreFunction(function () {
              state.self.onExit = oldOnExit;
            });
            return surrogate;
          }

          function stateEnteredSurrogate(state, toParams) {
            var oldOnEnter = state.self.onEnter;
            state.self.onEnter = function () {
              _StickyState.stateEntering(state, toParams, oldOnEnter);
            };
            restore.addRestoreFunction(function () {
              state.self.onEnter = oldOnEnter;
            });

            return state;
          }

          // TODO: This may be completely unnecessary now that we're using $$uirouterextrasreload temp param
          function stateUpdateParamsSurrogate(state, toParams) {
            var oldOnEnter = state.self.onEnter;
            state.self.onEnter = function () {
              _StickyState.stateEntering(state, toParams, oldOnEnter, true);
            };
            restore.addRestoreFunction(function () {
              state.self.onEnter = oldOnEnter;
            });

            return state;
          }

          function stateExitedSurrogate(state) {
            var oldOnExit = state.self.onExit;
            state.self.onExit = function () {
              _StickyState.stateExiting(state, exited, oldOnExit);
            };
            restore.addRestoreFunction(function () {
              state.self.onExit = oldOnExit;
            });

            return state;
          }


          // --------------------- decorated .transitionTo() logic starts here ------------------------
          if (toStateSelf) {
            var toState = internalStates[toStateSelf.name]; // have the state, now grab the internal state representation
            if (toState) {
              // Save the toState and fromState paths to be restored using restore()
              savedToStatePath = toState.path;
              savedFromStatePath = fromState.path;

              // Try to resolve options.reload to a state.  If so, we'll reload only up to the given state.
              var reload = options && options.reload || false;
              var reloadStateTree = reload && (reload === true ? savedToStatePath[0].self : $state.get(reload, rel));
              // If options.reload is a string or a state, we want to handle reload ourselves and not
              // let ui-router reload the entire toPath.
              if (options && reload && reload !== true)
                delete options.reload;

              var currentTransition = {
                toState: toState,
                toParams: toParams || {},
                fromState: fromState,
                fromParams: fromParams || {},
                options: options,
                reloadStateTree: reloadStateTree
              };

              pendingTransitions.push(currentTransition); // TODO: See if a list of pending transitions is necessary.
              pendingRestore = restore;

              // If we're reloading from a state and below, temporarily add a param to the top of the state tree
              // being reloaded, and add a param value to the transition.  This will cause the "has params changed
              // for state" check to return false, and the states will be reloaded.
              if (reloadStateTree) {
                currentTransition.toParams.$$uirouterextrasreload = Math.random();
                var params = reloadStateTree.$$state().params;
                var ownParams = reloadStateTree.$$state().ownParams;

                if (versionHeuristics.hasParamSet) {
                  var tempParam = new $urlMatcherFactoryProvider.Param('$$uirouterextrasreload');
                  params.$$uirouterextrasreload = ownParams.$$uirouterextrasreload = tempParam;
                  restore.restoreFunctions.push(function() {
                    delete params.$$uirouterextrasreload;
                    delete ownParams.$$uirouterextrasreload;
                  });
                } else {
                  params.push('$$uirouterextrasreload');
                  ownParams.push('$$uirouterextrasreload');
                  restore.restoreFunctions.push(function() {
                    params.length = params.length -1;
                    ownParams.length = ownParams.length -1;
                  });
                }
              }

              // $StickyStateProvider.processTransition analyzes the states involved in the pending transition.  It
              // returns an object that tells us:
              // 1) if we're involved in a sticky-type transition
              // 2) what types of exit transitions will occur for each "exited" path element
              // 3) what types of enter transitions will occur for each "entered" path element
              // 4) which states will be inactive if the transition succeeds.
              stickyTransitions = _StickyState.processTransition(currentTransition);

              if (DEBUG) debugTransition($log, currentTransition, stickyTransitions);

              // Begin processing of surrogate to and from paths.
              var surrogateToPath = toState.path.slice(0, stickyTransitions.keep);
              var surrogateFromPath = fromState.path.slice(0, stickyTransitions.keep);

              // Clear out and reload inactivePseudoState.locals each time transitionTo is called
              angular.forEach(inactivePseudoState.locals, function (local, name) {
                if (name.indexOf("@") != -1) delete inactivePseudoState.locals[name];
              });

              // Find all states that will be inactive once the transition succeeds.  For each of those states,
              // place its view-locals on the __inactives pseudostate's .locals.  This allows the ui-view directive
              // to access them and render the inactive views.
              for (var i = 0; i < stickyTransitions.inactives.length; i++) {
                var iLocals = stickyTransitions.inactives[i].locals;
                angular.forEach(iLocals, function (view, name) {
                  if (iLocals.hasOwnProperty(name) && name.indexOf("@") != -1) { // Only grab this state's "view" locals
                    inactivePseudoState.locals[name] = view; // Add all inactive views not already included.
                  }
                });
              }

              // Find all the states the transition will be entering.  For each entered state, check entered-state-transition-type
              // Depending on the entered-state transition type, place the proper surrogate state on the surrogate toPath.
              angular.forEach(stickyTransitions.enter, function (value, idx) {
                var surrogate;
                var enteringState = toState.path[idx];
                if (value === "reactivate") {
                  // Reactivated states require TWO surrogates.  The "phase 1 reactivated surrogates" are added to both
                  // to.path and from.path, and as such, are considered to be "kept" by UI-Router.
                  // This is required to get UI-Router to add the surrogate locals to the protoypal locals object
                  surrogate = stateReactivatedSurrogatePhase1(enteringState);
                  surrogateToPath.push(surrogate);
                  surrogateFromPath.push(surrogate);  // so toPath[i] === fromPath[i]

                  // The "phase 2 reactivated surrogate" is added to the END of the .path, after all the phase 1
                  // surrogates have been added.
                  reactivated.push(stateReactivatedSurrogatePhase2(enteringState));
                  terminalReactivatedState = enteringState;
                } else if (value === "updateStateParams") {
                  // If the state params have been changed, we need to exit any inactive states and re-enter them.
                  surrogate = stateUpdateParamsSurrogate(enteringState);
                  surrogateToPath.push(surrogate);
                  terminalReactivatedState = enteringState;
                } else if (value === "enter") {
                  // Standard enter transition.  We still wrap it in a surrogate.
                  surrogateToPath.push(stateEnteredSurrogate(enteringState));
                }
              });

              // Find all the states the transition will be exiting.  For each exited state, check the exited-state-transition-type.
              // Depending on the exited-state transition type, place a surrogate state on the surrogate fromPath.
              angular.forEach(stickyTransitions.exit, function (value, idx) {
                var exiting = fromState.path[idx];
                if (value === "inactivate") {
                  surrogateFromPath.push(stateInactivatedSurrogate(exiting));
                  exited.push(exiting);
                } else if (value === "exit") {
                  surrogateFromPath.push(stateExitedSurrogate(exiting));
                  exited.push(exiting);
                }
              });

              // Add surrogate for reactivated to ToPath again, this time without a matching FromPath entry
              // This is to get ui-router to call the surrogate's onEnter callback.
              if (reactivated.length) {
                angular.forEach(reactivated, function (surrogate) {
                  surrogateToPath.push(surrogate);
                });
              }

              // We may transition directly to an inactivated state, reactivating it.  In this case, we should
              // exit all of that state's inactivated children.
              if (toState === terminalReactivatedState) {
                var prefix = terminalReactivatedState.self.name + ".";
                var inactiveStates = _StickyState.getInactiveStates();
                var inactiveOrphans = [];
                inactiveStates.forEach(function (exiting) {
                  if (exiting.self.name.indexOf(prefix) === 0) {
                    inactiveOrphans.push(exiting);
                  }
                });
                inactiveOrphans.sort();
                inactiveOrphans.reverse();
                // Add surrogate exited states for all orphaned descendants of the Deepest Reactivated State
                surrogateFromPath = surrogateFromPath.concat(map(inactiveOrphans, function (exiting) {
                  return stateExitedSurrogate(exiting);
                }));
                exited = exited.concat(inactiveOrphans);
              }

              // Replace the .path variables.  toState.path and fromState.path are now ready for a sticky transition.
              toState.path = surrogateToPath;
              fromState.path = surrogateFromPath;

              var pathMessage = function (state) {
                return (state.surrogateType ? state.surrogateType + ":" : "") + state.self.name;
              };
              if (DEBUG) $log.debug("SurrogateFromPath: ", map(surrogateFromPath, pathMessage));
              if (DEBUG) $log.debug("SurrogateToPath:   ", map(surrogateToPath, pathMessage));
            }
          }

          // toState and fromState are all set up; now run stock UI-Router's $state.transitionTo().
          var transitionPromise = $state_transitionTo.apply($state, arguments);

          // Add post-transition promise handlers, then return the promise to the original caller.
          return transitionPromise.then(function transitionSuccess(state) {
            // First, restore toState and fromState to their original values.
            restore();
            if (DEBUG)  debugViewsAfterSuccess($log, internalStates[state.name], $state);

            state.status = 'active';  // TODO: This status is used in statevis.js, and almost certainly belongs elsewhere.

            return state;
          }, function transitionFailed(err) {
            restore();
            if (DEBUG &&
              err.message !== "transition prevented" &&
              err.message !== "transition aborted" &&
              err.message !== "transition superseded") {
              $log.debug("transition failed", err);
              console.log(err.stack);
            }
            return $q.reject(err);
          });
        };
        return $state;
      }]);
    }
  ]
);

function debugTransition($log, currentTransition, stickyTransition) {
  function message(path, index, state) {
    return (path[index] ? path[index].toUpperCase() + ": " + state.self.name : "(" + state.self.name + ")");
  }

  var inactiveLogVar = map(stickyTransition.inactives, function (state) {
    return state.self.name;
  });
  var enterLogVar = map(currentTransition.toState.path, function (state, index) {
    return message(stickyTransition.enter, index, state);
  });
  var exitLogVar = map(currentTransition.fromState.path, function (state, index) {
    return message(stickyTransition.exit, index, state);
  });

  var transitionMessage = currentTransition.fromState.self.name + ": " +
    angular.toJson(currentTransition.fromParams) + ": " +
    " -> " +
    currentTransition.toState.self.name + ": " +
    angular.toJson(currentTransition.toParams);

  $log.debug("   Current transition: ", transitionMessage);
  $log.debug("Before transition, inactives are:   : ", map(_StickyState.getInactiveStates(), function (s) {
    return s.self.name;
  }));
  $log.debug("After transition,  inactives will be: ", inactiveLogVar);
  $log.debug("Transition will exit:  ", exitLogVar);
  $log.debug("Transition will enter: ", enterLogVar);
}

function debugViewsAfterSuccess($log, currentState, $state) {
  $log.debug("Current state: " + currentState.self.name + ", inactive states: ", map(_StickyState.getInactiveStates(), function (s) {
    return s.self.name;
  }));

  var viewMsg = function (local, name) {
    return "'" + name + "' (" + local.$$state.name + ")";
  };
  var statesOnly = function (local, name) {
    return name != 'globals' && name != 'resolve';
  };
  var viewsForState = function (state) {
    var views = map(filterObj(state.locals, statesOnly), viewMsg).join(", ");
    return "(" + (state.self.name ? state.self.name : "root") + ".locals" + (views.length ? ": " + views : "") + ")";
  };

  var message = viewsForState(currentState);
  var parent = currentState.parent;
  while (parent && parent !== currentState) {
    if (parent.self.name === "") {
      // Show the __inactives before showing root state.
      message = viewsForState($state.$current.path[0]) + " / " + message;
    }
    message = viewsForState(parent) + " / " + message;
    currentState = parent;
    parent = currentState.parent;
  }

  $log.debug("Views: " + message);
}

