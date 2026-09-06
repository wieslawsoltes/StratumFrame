"""Optional browser interaction suite. Requires Python + Playwright, not app dependencies.
Normal: python tools/browser_smoke.py --url http://localhost:8080
Inline bundle (no navigation, Canvas fallback): python tools/browser_smoke.py --inline
Use --chromium /path/to/chromium to select an installed executable.
"""
from pathlib import Path
import argparse, json, math, datetime
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://localhost:8080')
parser.add_argument('--inline', action='store_true')
parser.add_argument('--chromium')
args = parser.parse_args()
checks=[]
def check(name, condition, details=None):
    record={'name':name, 'passed':bool(condition)}
    if details is not None: record['details']=details
    checks.append(record)
    if not condition: raise AssertionError(name)
    print('PASS', name)

with sync_playwright() as p:
    launch={'headless':True,'args':['--no-sandbox']}
    if args.chromium: launch['executable_path']=args.chromium
    browser=p.chromium.launch(**launch)
    page=browser.new_page(viewport={'width':1600,'height':1000},device_scale_factor=1)
    page.set_default_timeout(8000)
    errors=[]
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda msg: errors.append(msg.text) if msg.type=='error' else None)
    if args.inline: page.set_content((ROOT/'dist/stratum-frame.html').read_text(),wait_until='load')
    else: page.goto(args.url,wait_until='load')
    def solved(): page.wait_for_function('window.stratum && !stratum.running && stratum.state.results', timeout=60000)
    def run():
        page.locator('#run-button').click()
        solved()
    solved()
    initial=page.evaluate('''() => {window.originalSnapshot=stratum.store.snapshot();window.originalResults=stratum.state.results;return {backend:stratum.main.backend,stats:stratum.state.results.stats,frequencies:stratum.state.results.modes.map(x=>x.frequency)}}''')
    check('Default project solves in an actual browser worker', initial['stats']['activeDOFs']==234 and len(initial['frequencies'])==6, initial)
    check('Default first frequency agrees with independent Node run', abs(initial['frequencies'][0]-1.73661595763811)<1e-9)
    page.screenshot(path=str(ROOT/'docs/screenshot-workspace.png'),full_page=True)
    # Actual pointer picking, not a programmatic selection substitute.
    target=page.evaluate('''() => {const s=stratum,ns=new Map(s.model.nodes.map(n=>[n.id,n])); const e=s.model.elements.find(e=>Math.abs(ns.get(e.i).z-s.state.storyZ)<1e-7&&Math.abs(ns.get(e.j).z-s.state.storyZ)<1e-7);window.testFrame=e.id;const a=ns.get(e.i),b=ns.get(e.j),p=s.plan.project([(a.x+b.x)/2,(a.y+b.y)/2,a.z]);return {id:e.id,x:p.x,y:p.y};}''')
    box=page.locator('#plan-overlay').bounding_box()
    page.mouse.click(box['x']+target['x'], box['y']+target['y'])
    check('Plan pointer hit-testing selects the intended roof beam', page.evaluate('stratum.state.selection.has("e:"+testFrame)'))
    page.locator('#inspector-content select[data-property="section"]').select_option('B400')
    check('Section edit changes the model and invalidates results', page.evaluate('stratum.model.elements.find(e=>e.id===testFrame).section==="B400" && stratum.state.results===null && stratum.store.revision===1'))
    page.evaluate('stratum.action("undo")')
    check('UI undo restores the exact project snapshot', page.evaluate('stratum.store.snapshot()===originalSnapshot'))
    page.evaluate('stratum.action("redo")')
    check('UI redo reapplies the edited section', page.evaluate('stratum.model.elements.find(e=>e.id===testFrame).section==="B400"'))
    page.evaluate('stratum.action("undo")')
    # The real assignment dialog validates dimensional suffixes and commits atomically.
    page.locator('#inspector-content [data-action="load"]').click()
    page.locator('#load-case').select_option('LIVE')
    page.locator('#load-v2').fill('-10 kN/m')
    page.locator('#load-replace').check()
    page.locator('#dialog-submit').click()
    page.wait_for_function('!document.querySelector("#dialog").open')
    check('Load dialog stores the physical SI value and updates the case', page.evaluate('stratum.model.loads.some(l=>l.element===testFrame&&l.case==="LIVE"&&l.value[2]===-10000) && stratum.state.caseId==="LIVE" && document.querySelector("#case-select").value==="LIVE"'))
    run()
    delta=page.evaluate('Math.max(...stratum.state.results.static.LIVE.u.map((x,i)=>Math.abs(x-originalResults.static.LIVE.u[i])))')
    check('Edited load changes recomputed structural displacements', delta>1e-7, {'maxDisplacementChangeM':delta})
    page.locator('#inspector-content [data-action="load"]').click()
    page.locator('#load-v2').fill('3 m')
    revision=page.evaluate('stratum.store.revision')
    page.locator('#dialog-submit').click()
    page.wait_for_timeout(60)
    check('Dimensionally invalid assignment is rejected without a transaction', page.evaluate('document.querySelector("#dialog").open && !!document.querySelector("#dialog-error").textContent') and page.evaluate('stratum.store.revision')==revision)
    page.locator('#dialog .secondary-button').click()
    # End releases are real model assignments.
    page.evaluate('stratum.action("releases")')
    page.locator('#release-4').check()
    page.locator('#release-10').check()
    page.locator('#dialog-submit').click()
    page.wait_for_function('!document.querySelector("#dialog").open')
    check('Release dialog assigns independent local end components', page.evaluate('stratum.model.elements.find(e=>e.id===testFrame).releases[4] && stratum.model.elements.find(e=>e.id===testFrame).releases[10]'))
    page.evaluate('stratum.action("undo")')
    # Restore the reference model before mesh refinement comparison.
    page.evaluate('stratum.store.replace(JSON.parse(originalSnapshot),"Restore baseline");stratum.select("e:"+testFrame);stratum.action("split")')
    check('Splitting a loaded member preserves load density on both children', page.evaluate('stratum.model.nodes.length===85 && stratum.model.elements.length===175 && stratum.selectedElements().every(e=>stratum.model.loads.some(l=>l.element===e.id&&l.case==="LIVE"&&l.type==="udl"&&l.value[2]===-5000))'))
    run()
    splitDelta=page.evaluate('Math.max(...originalResults.static.LIVE.u.map((x,i)=>Math.abs(x-stratum.state.results.static.LIVE.u[i])))')
    check('Split model preserves original-joint vertical-load displacements', splitDelta<1e-9, {'maxDifferenceMOrRad':splitDelta})
    # Render every output; all geometry comes from the computed result snapshot.
    page.evaluate('stratum.select(null)')
    for display in ['model','loads','deformed','mode','axial','v2','v3','torsion','m2','m3','reactions']:
        page.evaluate('(display)=>stratum.setDisplay(display)',display)
        page.wait_for_timeout(45)
        check('Display '+display+' accepts current computed results', page.evaluate('stratum.state.display')==display)
    page.locator('#display-select').select_option('mode')
    page.locator('#mode-select').select_option('1')
    page.locator('#animate-button').click()
    page.wait_for_timeout(350)
    check('Modal animation advances the real modal shape state', page.evaluate('stratum.state.animate && stratum.state.modeIndex===1 && stratum.state.time>0'))
    page.locator('#animate-button').click()
    page.locator('#unit-select').select_option('US')
    check('Display-unit changes leave canonical SI model untouched', page.evaluate('stratum.model.units==="SI" && stratum.model.nodes[1].x===6 && stratum.units.force==="kip"'))
    page.locator('#unit-select').select_option('SI')
    # File input imports a real project rather than replacing model internals directly.
    page.locator('#file-input').set_input_files({'name':'reference.stratum.json','mimeType':'application/json','buffer':page.evaluate('originalSnapshot').encode()})
    page.wait_for_timeout(80)
    check('Project file import validates and restores geometry', page.evaluate('stratum.model.nodes.length===84 && stratum.model.elements.length===174 && stratum.state.results===null'))
    page.evaluate('stratum.state.display="model";stratum.state.caseId="LATERAL";stratum.state.storyZ=20.4;stratum.refresh(true)')
    run()
    page.locator('#display-select').select_option('deformed')
    page.wait_for_timeout(120)
    page.screenshot(path=str(ROOT/'docs/screenshot-deformed.png'),full_page=True)
    # The single-file build also contains the actual numerical benchmark module.
    page.evaluate('stratum.action("benchmarks")')
    page.wait_for_function('document.querySelector("#dialog-content").textContent.includes("32 / 32")',timeout=30000)
    check('In-app analytical benchmarks run successfully from the portable bundle', True)
    page.locator('#dialog-submit').click()
    # A compact viewport must retain a usable story selector for drawing.
    page.set_viewport_size({'width':430,'height':932})
    page.evaluate('stratum.setTool("joint")')
    page.wait_for_timeout(120)
    check('Mobile drawing switches to plan with an active-story selector', page.evaluate('stratum.main.kind==="plan"') and page.locator('#main-story-select').is_visible())
    page.screenshot(path=str(ROOT/'docs/screenshot-mobile.png'),full_page=True)
    check('No uncaught JavaScript or console errors during interaction suite', len(errors)==0, errors)
    report={'suite':'Stratum Frame browser interaction verification','timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'browser':browser.version,'mode':'inline about:blank' if args.inline else args.url,'renderBackend':initial['backend'],'webgpuValidated':initial['backend']=='WebGPU','passed':len(checks),'total':len(checks),'checks':checks,'errors':errors}
    (ROOT/'docs/browser-results.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k not in ['checks']},indent=2))
    browser.close()
