package ldap

import (
	"crypto/tls"
	"net"
	"sync"

	"github.com/pires/go-proxyproto"
	log "github.com/sirupsen/logrus"
	"goauthentik.io/internal/crypto"
	"goauthentik.io/internal/outpost/ak"
	"goauthentik.io/internal/outpost/ldap/metrics"

	"github.com/nmcclain/ldap"
)

type LDAPServer struct {
	s           *ldap.Server
	log         *log.Entry
	ac          *ak.APIController
	cs          *ak.CryptoStore
	defaultCert *tls.Certificate
	providers   []*ProviderInstance
}

func NewServer(ac *ak.APIController) *LDAPServer {
	s := ldap.NewServer()
	s.EnforceLDAP = true
	ls := &LDAPServer{
		s:         s,
		log:       log.WithField("logger", "authentik.outpost.ldap"),
		ac:        ac,
		cs:        ak.NewCryptoStore(ac.Client.CryptoApi),
		providers: []*ProviderInstance{},
	}
	defaultCert, err := crypto.GenerateSelfSignedCert()
	if err != nil {
		log.Warning(err)
	}
	ls.defaultCert = &defaultCert
	s.BindFunc("", ls)
	s.SearchFunc("", ls)
	s.CloseFunc("", ls)
	return ls
}

func (ls *LDAPServer) Type() string {
	return "ldap"
}

func (ls *LDAPServer) StartLDAPServer() error {
	listen := "0.0.0.0:3389"

	ln, err := net.Listen("tcp", listen)
	if err != nil {
		ls.log.WithField("listen", listen).WithError(err).Fatalf("FATAL: listen failed")
	}
	proxyListener := &proxyproto.Listener{Listener: ln}
	defer proxyListener.Close()

	ls.log.WithField("listen", listen).Info("Starting ldap server")
	err = ls.s.Serve(proxyListener)
	if err != nil {
		return err
	}
	ls.log.Printf("closing %s", ln.Addr())
	return ls.s.ListenAndServe(listen)
}

func (ls *LDAPServer) Start() error {
	wg := sync.WaitGroup{}
	wg.Add(3)
	go func() {
		defer wg.Done()
		metrics.RunServer()
	}()
	go func() {
		defer wg.Done()
		err := ls.StartLDAPServer()
		if err != nil {
			panic(err)
		}
	}()
	go func() {
		defer wg.Done()
		err := ls.StartLDAPTLSServer()
		if err != nil {
			panic(err)
		}
	}()
	wg.Wait()
	return nil
}

func (ls *LDAPServer) TimerFlowCacheExpiry() {
	for _, p := range ls.providers {
		ls.log.WithField("flow", p.flowSlug).Debug("Pre-heating flow cache")
		p.binder.TimerFlowCacheExpiry()
	}
}
