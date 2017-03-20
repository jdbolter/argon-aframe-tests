/// <reference types="@argonjs/argon"/>
/// <reference types="three"/>
/// <reference types="tween.js"/>

// save some local references to commonly used classes
const Cartesian3 = Argon.Cesium.Cartesian3;
const Quaternion = Argon.Cesium.Quaternion;
const CesiumMath = Argon.Cesium.CesiumMath;

// set up Argon (unlike regular apps, we call initRealityViewer instead of init)
// Defining a protocol allows apps to communicate with the reality in a
// reliable way. 
const app = Argon.initRealityViewer({
    protocols: ['ael.gatech.panorama@v1']
});

// set up THREE.  Create a scene, a perspective camera and an object
// for the user's location
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
scene.add(camera);

// We use the standard WebGLRenderer when we only need WebGL-based content
const renderer = new THREE.WebGLRenderer({ 
    alpha: true, 
    logarithmicDepthBuffer: true
});

// account for the pixel density of the device
renderer.setPixelRatio(window.devicePixelRatio);
app.view.element.appendChild(renderer.domElement);

// Tell argon what local coordinate system you want.  The default coordinate
// frame used by Argon is Cesium's FIXED frame, which is centered at the center
// of the earth and oriented with the earth's axes.  
// The FIXED frame is inconvenient for a number of reasons: the numbers used are
// large and cause issues with rendering, and the orientation of the user's "local
// view of the world" is different that the FIXED orientation (my perception of "up"
// does not correspond to one of the FIXED axes).  
// Therefore, Argon uses a local coordinate frame that sits on a plane tangent to 
// the earth near the user's current location.  This frame automatically changes if the
// user moves more than a few kilometers.
// The EUS frame cooresponds to the typical 3D computer graphics coordinate frame, so we use
// that here.  The other option Argon supports is localOriginEastNorthUp, which is
// more similar to what is used in the geospatial industry
app.context.defaultReferenceFrame = app.context.localOriginEastUpSouth;

interface PanoramaInfo {
    url: string,
    longitude?: number,
    latitude?: number,
    height?: number,
    offsetDegrees?: number
}

interface Panorama extends PanoramaInfo {
    entity:Argon.Cesium.Entity,
    texture?:Promise<THREE.Texture>
}

// A map to store our panoramas
var panoramas = new Map<string, Panorama>();
var currentPano:Panorama;

// Create two pano spheres we can transition between
var sphereGeometry = new THREE.SphereGeometry(100, 32, 32);
var panoSpheres:Array<THREE.Mesh> = [new THREE.Mesh, new THREE.Mesh];
panoSpheres.forEach((mesh)=>{
    mesh.geometry = sphereGeometry;
    const material = new THREE.MeshBasicMaterial();
    material.transparent = true;
    mesh.material = material;
    scene.add(mesh);
})
var currentSphere = 0;

// Create an entity to represent the virtual eye
const virtualEye = new Argon.Cesium.Entity({
    orientation: new Argon.Cesium.ConstantProperty(Quaternion.fromAxisAngle(Cartesian3.UNIT_X, Argon.Cesium.CesiumMath.PI_OVER_TWO))
})

// Creating a lot of garbage slows everything down. Not fun.
// Let's create some recyclable objects that we can use later.
const scratchCartesian = new Cartesian3;
const scratchQuaternion = new Quaternion;
const scratchQuaternionDragPitch = new Quaternion;
const scratchQuaternionDragYaw = new Quaternion;
const frustum = new Argon.Cesium.PerspectiveFrustum();

const aggregator = new Argon.Cesium.CameraEventAggregator(<any>document.documentElement);

const subviews = new Array<Argon.SerializedSubview>();

// Reality views must raise frame events at regular intervals in order to 
// drive updates for the entire system
app.device.frameStateEvent.addEventListener((frameState)=>{
    const time = frameState.time;
    Argon.SerializedSubviewList.clone(frameState.subviews, subviews);
    
    // Get the physical device orientation
    const deviceUserOrientation = Argon.getEntityOrientation(
        app.device.user,
        time, 
        app.device.stage, 
        scratchQuaternion
    );

    if (deviceUserOrientation) {
        // Rotate our virtual eye according to the device orientation
        // (the eye should be positioned at the current panorama)
        (<any>virtualEye.orientation).setValue(deviceUserOrientation);
    }

    if (!frameState.strict) {
        Argon.decomposePerspectiveProjectionMatrix(subviews[0].projectionMatrix, frustum);
        frustum.fov = app.view.subviews[0].frustum.fov;

        if (aggregator.isMoving(Argon.Cesium.CameraEventType.WHEEL)) {
            const wheelMovement = aggregator.getMovement(Argon.Cesium.CameraEventType.WHEEL);
            const diff = wheelMovement.endPosition.y;
            frustum.fov = Math.min(Math.max(frustum.fov - diff * 0.02, Math.PI/8), Math.PI-Math.PI/8);
        }

        if (aggregator.isMoving(Argon.Cesium.CameraEventType.PINCH)) {
            const pinchMovement = aggregator.getMovement(Argon.Cesium.CameraEventType.PINCH);
            const diff = pinchMovement.distance.endPosition.y - pinchMovement.distance.startPosition.y;
            frustum.fov = Math.min(Math.max(frustum.fov - diff * 0.02, Math.PI/8), Math.PI-Math.PI/8);
        }

        if (!deviceUserOrientation && aggregator.isMoving(Argon.Cesium.CameraEventType.LEFT_DRAG)) {
            const dragMovement = aggregator.getMovement(Argon.Cesium.CameraEventType.LEFT_DRAG);
            const currentOrientation = Argon.getEntityOrientationInReferenceFrame(virtualEye, time, currentPano.entity, scratchQuaternion);
            // const dragPitch = Quaternion.fromAxisAngle(Cartesian3.UNIT_X, frustum.fov * (dragMovement.endPosition.y - dragMovement.startPosition.y) / app.viewport.current.height, scratchQuaternionDragPitch);
            const dragYaw = Quaternion.fromAxisAngle(Cartesian3.UNIT_Y, frustum.fov * (dragMovement.endPosition.x - dragMovement.startPosition.x) / app.view.viewport.width, scratchQuaternionDragYaw);
            // const drag = Quaternion.multiply(dragPitch, dragYaw, dragYaw);

            const newOrientation = Quaternion.multiply(currentOrientation, dragYaw, dragYaw);
            (<any>virtualEye.orientation).setValue(newOrientation);
        }
        
        subviews.forEach((s)=>{
            const aspect = s.viewport.width / s.viewport.height;
            frustum.aspectRatio = isFinite(aspect) && aspect !== 0 ? aspect : 1;
            Argon.Cesium.Matrix4.clone(frustum.projectionMatrix, s.projectionMatrix);
        });
    }

    aggregator.reset();

    // By publishing a view state, we are describing where we
    // are in the world, what direction we are looking, and how we are rendering 
    const contextFrameState = app.device.createContextFrameState(
        time,
        frameState.viewport,
        subviews,
        virtualEye
    );

    app.context.submitFrameState(contextFrameState);
});


// the updateEvent is called each time the 3D world should be
// rendered, before the renderEvent.  The state of your application
// should be updated here.
app.updateEvent.addEventListener(() => {
    TWEEN.update();
})


// renderEvent is fired whenever argon wants the app to update its display
app.renderEvent.addEventListener(() => {
    // set the renderer to know the current size of the viewport.
    // This is the full size of the viewport, which would include
    // both views if we are in stereo viewing mode
    const viewport = app.view.viewport;
    renderer.setSize(viewport.width, viewport.height);
    
    // there is 1 subview in monocular mode, 2 in stereo mode
    for (let subview of app.view.subviews) {
        // set camera orientation, ignoring the position since panoramas do not support free
        // movement
        camera.quaternion.copy(<any>subview.pose.orientation);
        // set the projection matrix
        camera.projectionMatrix.fromArray(<any>subview.frustum.projectionMatrix);

        // set the viewport for this view
        let {x,y,width,height} = subview.viewport;
        renderer.setViewport(x,y,width,height);

        // set the webGL rendering parameters and render this view
        renderer.setScissor(x,y,width,height);
        renderer.setScissorTest(true);
        renderer.render(scene, camera);
    }
})

// create a texture loader
const loader = new THREE.TextureLoader();
loader.setCrossOrigin('anonymous');

// when the a controlling session connects, we can communite with it to
// receive commands (or even send information back, if appropriate)
app.reality.connectEvent.addEventListener((controlSession)=>{
    controlSession.on['edu.gatech.ael.panorama.loadPanorama'] = (pano:PanoramaInfo) => {
        // if you throw an error in a message handler, the remote session will see the error!
        if (!pano.url) throw new Error('Expected an equirectangular image url!')
        
        const offsetRadians = (pano.offsetDegrees || 0) * CesiumMath.DEGREES_PER_RADIAN;
        
        const entity = new Argon.Cesium.Entity;
        if (Argon.Cesium.defined(pano.longitude) &&
            Argon.Cesium.defined(pano.longitude)) {
            const positionProperty = new Argon.Cesium.ConstantPositionProperty(undefined);
            const positionValue = Cartesian3.fromDegrees(pano.longitude, pano.latitude, pano.height || 0);
            positionProperty.setValue(positionValue, Argon.Cesium.ReferenceFrame.FIXED);
            entity.position = positionProperty;
            const orientationProperty = new Argon.Cesium.ConstantProperty();
            // calculate the orientation for the ENU coodrinate system at the given position
            const orientationValue = Argon.Cesium.Transforms.headingPitchRollQuaternion(positionValue, 0, 0, 0);
            // TODO: apply offsetDegrees to orientation
            orientationProperty.setValue(orientationValue);
            entity.orientation = orientationProperty;
        }
        
        var texture = new Promise<THREE.Texture>((resolve)=>{
            loader.load(pano.url, function ( texture ) {
                texture.minFilter = THREE.LinearFilter;
                resolve(texture);
            });
        });
        
        panoramas.set(pano.url, {
            url: pano.url,
            longitude: pano.longitude,
            latitude: pano.latitude,
            height: pano.height,
            offsetDegrees: pano.offsetDegrees,
            entity,
            texture
        });
        
        // We can optionally return a value (or a promise of a value) in a message handler. 
        // In this case, if three.js throws an error while attempting to load
        // the texture, the error will be passed to the remote session. Otherwise,
        // this function will respond as fulfilled when the texture is loaded. 
        return texture.then(()=>{})
    }
    controlSession.on['edu.gatech.ael.panorama.deletePanorama'] = ({url}) => {
        panoramas.delete(url);
    }
    controlSession.on['edu.gatech.ael.panorama.showPanorama'] = (options:ShowPanoramaOptions) => {
        showPanorama(options);
    }
})

interface Transition {
    easing?:string,
    duration?:number
}

interface ShowPanoramaOptions {
    url:string,
    transition:Transition,
}

function showPanorama(options:ShowPanoramaOptions) {
    const url = options.url;
    const transition:Transition = options.transition || {};
    const easing = resolve(transition.easing, TWEEN.Easing) || TWEEN.Easing.Linear.None;
    
    if (!url) throw new Error('Expected a url');
    if (!easing) throw new Error('Unknown easing: ' + easing);
    
    const panoOut = currentPano;
    const panoIn = panoramas.get(url);
    if (!panoIn) throw new Error('Unknown pano: '+ url + ' (did you forget to add the panorama first?)')
    currentPano = panoIn;

    virtualEye.position = new Argon.Cesium.ConstantPositionProperty(Cartesian3.ZERO, currentPano.entity);
    
    // get the threejs objects for rendering our panoramas
    const sphereOut = panoSpheres[currentSphere];
    currentSphere++; currentSphere %= 2;
    const sphereIn = panoSpheres[currentSphere];
    const inMaterial = sphereIn.material as THREE.MeshBasicMaterial;
    const outMaterial = sphereOut.material as THREE.MeshBasicMaterial;
    
    // update the material for the incoming panorama
    inMaterial.map = undefined;
    inMaterial.opacity = 1;
    inMaterial.needsUpdate = true;
    panoIn.texture.then((texture)=>{
        inMaterial.map = texture;
        inMaterial.needsUpdate = true;
    })
    
    // update the pose of the pano spheres
    sphereIn.rotation.y = (panoIn.offsetDegrees || 0) * CesiumMath.RADIANS_PER_DEGREE;
    
    // negate one scale component to flip the spheres inside-out,
    // and make the incoming sphere slightly smaller so it is seen infront of
    // the outgoing sphere
    sphereIn.scale.set(-1,1,1);
    sphereOut.scale.set(-0.9,0.9,0.9);
    
    // force render order
    sphereIn.renderOrder = 0;
    sphereOut.renderOrder = 1;
    
    // fade out the old pano using tween.js!
    TWEEN.removeAll();
    var outTween = new TWEEN.Tween(outMaterial);
    outTween.to({opacity:0}, transition.duration).onUpdate(()=>{
        outMaterial.needsUpdate = true;
    }).easing(easing).start();
    outMaterial.opacity = 1;
    outMaterial.needsUpdate = true;
}

function resolve(path:string, obj, safe:boolean=true) {
    if (!path) return undefined;
    return path.split('.').reduce(function(prev, curr) {
        return !safe ? prev[curr] : (prev ? prev[curr] : undefined)
    }, obj || self)
}