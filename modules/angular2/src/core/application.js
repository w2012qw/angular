import {Injector, bind, OpaqueToken} from 'angular2/di';
import {Type, FIELD, isBlank, isPresent, BaseException, assertionsEnabled, print} from 'angular2/src/facade/lang';
import {DOM, Element} from 'angular2/src/facade/dom';
import {Compiler, CompilerCache} from './compiler/compiler';
import {ProtoView} from './compiler/view';
import {Reflector, reflector} from 'angular2/src/reflection/reflection';
import {Parser, Lexer, ChangeDetection, dynamicChangeDetection, jitChangeDetection} from 'angular2/change_detection';
import {TemplateLoader} from './compiler/template_loader';
import {DirectiveMetadataReader} from './compiler/directive_metadata_reader';
import {DirectiveMetadata} from './compiler/directive_metadata';
import {List, ListWrapper} from 'angular2/src/facade/collection';
import {PromiseWrapper} from 'angular2/src/facade/async';
import {VmTurnZone} from 'angular2/src/core/zone/vm_turn_zone';
import {LifeCycle} from 'angular2/src/core/life_cycle/life_cycle';
import {ShadowDomStrategy, NativeShadowDomStrategy} from 'angular2/src/core/compiler/shadow_dom_strategy';
import {XHR} from 'angular2/src/core/compiler/xhr/xhr';
import {XHRImpl} from 'angular2/src/core/compiler/xhr/xhr_impl';

var _rootInjector: Injector;

// Contains everything that is safe to share between applications.
var _rootBindings = [
  bind(Reflector).toValue(reflector),
  bind(ChangeDetection).toValue(dynamicChangeDetection),
  Compiler,
  CompilerCache,
  TemplateLoader,
  DirectiveMetadataReader,
  Parser,
  Lexer,
  bind(ShadowDomStrategy).toValue(new NativeShadowDomStrategy()),
  bind(XHR).toValue(new XHRImpl()),
];

export var appViewToken = new OpaqueToken('AppView');
export var appChangeDetectorToken = new OpaqueToken('AppChangeDetector');
export var appElementToken = new OpaqueToken('AppElement');
export var appComponentAnnotatedTypeToken = new OpaqueToken('AppComponentAnnotatedType');
export var appDocumentToken = new OpaqueToken('AppDocument');

function _injectorBindings(appComponentType) {
  return [
      bind(appDocumentToken).toValue(DOM.defaultDoc()),
      bind(appComponentAnnotatedTypeToken).toFactory((reader) => {
        // TODO(rado): inspect annotation here and warn if there are bindings,
        // lightDomServices, and other component annotations that are skipped
        // for bootstrapping components.
        return reader.read(appComponentType);
      }, [DirectiveMetadataReader]),

      bind(appElementToken).toFactory((appComponentAnnotatedType, appDocument) => {
        var selector = appComponentAnnotatedType.annotation.selector;
        var element = DOM.querySelector(appDocument, selector);
        if (isBlank(element)) {
          throw new BaseException(`The app selector "${selector}" did not match any elements`);
        }
        return element;
      }, [appComponentAnnotatedTypeToken, appDocumentToken]),

      bind(appViewToken).toAsyncFactory((changeDetection, compiler, injector, appElement,
        appComponentAnnotatedType, strategy) => {
        return compiler.compile(appComponentAnnotatedType.type, null).then(
            (protoView) => {
          var appProtoView = ProtoView.createRootProtoView(protoView, appElement,
            appComponentAnnotatedType, changeDetection.createProtoChangeDetector('root'),
            strategy);
          // The light Dom of the app element is not considered part of
          // the angular application. Thus the context and lightDomInjector are
          // empty.
          var view = appProtoView.instantiate(null);
          view.hydrate(injector, null, new Object());
          return view;
        });
      }, [ChangeDetection, Compiler, Injector, appElementToken, appComponentAnnotatedTypeToken,
          ShadowDomStrategy]),

      bind(appChangeDetectorToken).toFactory((rootView) => rootView.changeDetector,
          [appViewToken]),
      bind(appComponentType).toFactory((rootView) => rootView.elementInjectors[0].getComponent(),
          [appViewToken]),
      bind(LifeCycle).toFactory(() => new LifeCycle(null, assertionsEnabled()),[])
  ];
}

function _createVmZone(givenReporter:Function){
  var defaultErrorReporter = (exception, stackTrace) => {
    var longStackTrace = ListWrapper.join(stackTrace, "\n\n-----async gap-----\n");
    print(`${exception}\n\n${longStackTrace}`);
    throw exception;
  };

  var reporter = isPresent(givenReporter) ? givenReporter : defaultErrorReporter;

  var zone = new VmTurnZone({enableLongStackTrace: assertionsEnabled()});
  zone.initCallbacks({onErrorHandler: reporter});
  return zone;
}

// Multiple calls to this method are allowed. Each application would only share
// _rootInjector, which is not user-configurable by design, thus safe to share.
export function bootstrap(appComponentType: Type, bindings=null, givenBootstrapErrorReporter=null) {
  var bootstrapProcess = PromiseWrapper.completer();

  var zone = _createVmZone(givenBootstrapErrorReporter);
  zone.run(() => {
    // TODO(rado): prepopulate template cache, so applications with only
    // index.html and main.js are possible.

    var appInjector = _createAppInjector(appComponentType, bindings);

    PromiseWrapper.then(appInjector.asyncGet(appViewToken),
      (rootView) => {
        // retrieve life cycle: may have already been created if injected in root component
        var lc=appInjector.get(LifeCycle); 
        lc.registerWith(zone, rootView.changeDetector);
        lc.tick(); //the first tick that will bootstrap the app

        bootstrapProcess.complete(appInjector);
      },

      (err) => {
        bootstrapProcess.reject(err)
      });
  });

  return bootstrapProcess.promise;
}

function _createAppInjector(appComponentType: Type, bindings: List): Injector {
  if (isBlank(_rootInjector)) _rootInjector = new Injector(_rootBindings);
  var mergedBindings = isPresent(bindings) ?
      ListWrapper.concat(_injectorBindings(appComponentType), bindings) :
      _injectorBindings(appComponentType);
  return _rootInjector.createChild(mergedBindings);
}
